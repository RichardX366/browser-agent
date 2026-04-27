const ELEMENT_MAP_KEY = '__elementMap';

function ensureElementMap(root = globalThis) {
  if (!root[ELEMENT_MAP_KEY]) root[ELEMENT_MAP_KEY] = Object.create(null);
  return root[ELEMENT_MAP_KEY];
}

function createRefId(prefix = 'ref') {
  const random =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      : `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`;
  return `${prefix}_${random}`;
}

function storeElementRef(refId, element, root = globalThis) {
  const map = ensureElementMap(root);
  map[refId] =
    typeof WeakRef !== 'undefined'
      ? new WeakRef(element)
      : { deref: () => element };
  return refId;
}

function resolveElementRef(refId, root = globalThis) {
  const map = root[ELEMENT_MAP_KEY];
  if (!map || !map[refId]) return null;

  const element = map[refId].deref ? map[refId].deref() : map[refId];
  if (!element || !element.isConnected) {
    delete map[refId];
    return null;
  }

  return element;
}

function removeElementRef(refId, root = globalThis) {
  const map = root[ELEMENT_MAP_KEY];
  if (map && map[refId]) delete map[refId];
}

async function collectOpenAISchemas(tools) {
  return Promise.all(
    (tools || []).map(async (tool) => {
      if (tool?.toOpenAISchema) return tool.toOpenAISchema();
      return {
        name: tool.name,
        description: tool.description || '',
        input_schema: tool.input_schema || { type: 'object', properties: {} },
      };
    }),
  );
}

function serializeToolJson(tools) {
  return JSON.stringify(tools, null, 2);
}

function parseFindOutput(text) {
  const lines = String(text || '')
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  let found = 0;
  let error = null;
  let more = false;
  const matches = [];

  for (const line of lines) {
    if (line.startsWith('FOUND:')) {
      found = Number.parseInt(line.split(':')[1].trim(), 10) || 0;
    } else if (line.startsWith('ERROR:')) {
      error = line.slice(6).trim();
    } else if (line.startsWith('MORE:')) {
      more = true;
    } else if (line.startsWith('ref_') && line.includes('|')) {
      const [ref, role, name, type, ...rest] = line
        .split('|')
        .map((part) => part.trim());
      matches.push({
        ref,
        role,
        name,
        type: type || undefined,
        description: rest.join(' | ') || undefined,
      });
    }
  }

  return { found, error, more, matches };
}

function stringifyRefMatches(matches) {
  return matches
    .map(
      (match) =>
        `${match.ref} | ${match.role} | ${match.name} | ${match.type || ''} | ${match.description || ''}`,
    )
    .join('\n');
}

async function dispatchMouseEvent(tabId, debuggerApi, options) {
  const {
    type,
    x,
    y,
    button = 'left',
    clickCount = 1,
    modifiers = 0,
  } = options;
  return debuggerApi.sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button,
    clickCount,
    modifiers,
  });
}

async function dispatchKeyEvent(tabId, debuggerApi, options) {
  return debuggerApi.sendCommand(tabId, 'Input.dispatchKeyEvent', options);
}

async function clickAt(tabId, debuggerApi, x, y, options = {}) {
  const button = options.button || 'left';
  const clickCount = options.clickCount || 1;
  const modifiers = options.modifiers || 0;

  await dispatchMouseEvent(tabId, debuggerApi, {
    type: 'mousePressed',
    x,
    y,
    button,
    clickCount,
    modifiers,
  });
  await dispatchMouseEvent(tabId, debuggerApi, {
    type: 'mouseReleased',
    x,
    y,
    button,
    clickCount,
    modifiers,
  });
}

async function doubleClickAt(tabId, debuggerApi, x, y, options = {}) {
  return clickAt(tabId, debuggerApi, x, y, { ...options, clickCount: 2 });
}

async function typeText(tabId, debuggerApi, text) {
  await dispatchKeyEvent(tabId, debuggerApi, {
    type: 'rawKeyDown',
    key: 'Unidentified',
  });
  return debuggerApi.sendCommand(tabId, 'Input.insertText', { text });
}

async function scrollBy(tabId, debuggerApi, x, y, deltaX, deltaY) {
  const normalizedDeltaX = Number.isFinite(Number(deltaX)) ? Number(deltaX) : 0;
  const normalizedDeltaY = Number.isFinite(Number(deltaY)) ? Number(deltaY) : 0;
  return dispatchMouseEvent(tabId, debuggerApi, {
    type: 'mouseWheel',
    x,
    y,
    deltaX: normalizedDeltaX,
    deltaY: normalizedDeltaY,
  });
}

function makeTool(name, description, inputSchema, execute) {
  return {
    name,
    description,
    input_schema: inputSchema,
    execute,
    toOpenAISchema: async () => ({
      name,
      description,
      input_schema: inputSchema,
    }),
  };
}

function createFunctionTool(name, description, inputSchema, impl) {
  return makeTool(name, description, inputSchema, async (input, context) =>
    impl(input, context),
  );
}

function describeSchema(schema, path = []) {
  if (!schema || typeof schema !== 'object') return schema;

  if (!schema.description && path.length > 0) {
    const name = path[path.length - 1];
    schema.description = `Value for ${name}.`;
  }

  if (schema.properties) {
    for (const [key, child] of Object.entries(schema.properties)) {
      describeSchema(child, [...path, key]);
    }
  }

  if (schema.items) {
    describeSchema(schema.items, [...path, 'item']);
  }

  return schema;
}

function createTabsContextTool(getTabsContext) {
  return makeTool(
    'tabs_context',
    'Get the active tab and available tabs in the current group.',
    {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Optional tab to focus on.' },
      },
      required: [],
    },
    async (input, context) => getTabsContext(input, context),
  );
}

function createTabControlTool(tabControlImpl) {
  return makeTool(
    'tab_control',
    'Open, switch, close, or navigate browser tabs.',
    {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'switch', 'close', 'navigate', 'back', 'forward'],
          description:
            'Tab operation to perform: open, switch, close, navigate, back, or forward.',
        },
        url: {
          type: 'string',
          description:
            'URL to open or navigate to. If no scheme is provided, https:// is assumed.',
        },
        tabId: {
          type: 'number',
          description:
            'Target tab id. For navigate/switch/close, omitted means the active tab.',
        },
        index: {
          type: 'number',
          description: 'Target tab index for switching when tabId is omitted.',
        },
        active: {
          type: 'boolean',
          description: 'Whether an opened tab should become active.',
        },
      },
      required: ['action'],
    },
    async (input, context) => tabControlImpl(input, context),
  );
}

function createReadPageTool(readPageImpl) {
  return makeTool(
    'read_page',
    'Get an accessibility tree representation of elements on the page.',
    {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['interactive', 'all'],
          description:
            'Which elements to include: interactive controls only, or all visible elements.',
        },
        tabId: {
          type: 'number',
          description: 'Browser tab id to inspect.',
        },
        depth: {
          type: 'number',
          description: 'Optional traversal depth limit for page extraction.',
        },
        ref_id: {
          type: 'string',
          description: 'Optional prefix or id hint for generated element refs.',
        },
        max_chars: {
          type: 'number',
          description: 'Maximum characters of page data to return.',
        },
      },
      required: [],
    },
    async (input, context) => readPageImpl(input, context),
  );
}

function createFindTool(findImpl) {
  return makeTool(
    'find',
    'Find elements on the page using natural language and return ref IDs.',
    {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Natural-language or text query for matching page elements.',
        },
        tabId: {
          type: 'number',
          description: 'Browser tab id to search.',
        },
      },
      required: ['query'],
    },
    async (input, context) => findImpl(input, context),
  );
}

function pointTargetProperties() {
  return {
    coordinate: {
      type: 'array',
      description:
        'Target x/y viewport coordinate. Use this when no element ref is available.',
      items: { type: 'number' },
      minItems: 2,
      maxItems: 2,
    },
    ref: {
      type: 'string',
      description:
        'Element ref returned by read_page or find. Prefer this over coordinates when available.',
    },
    tabId: {
      type: 'number',
      description: 'Browser tab id to control. Omit to use the active tab.',
    },
  };
}

function createComputerActionTool(name, action, description, inputSchema, computerImpl) {
  return makeTool(name, description, inputSchema, async (input, context) =>
    computerImpl({ ...input, action }, context),
  );
}

function createComputerActionTools(computerImpl) {
  const runComputer =
    computerImpl || (async () => ({ error: 'computer not implemented' }));

  return [
    createComputerActionTool(
      'left_click',
      'left_click',
      'Left-click a page element or viewport coordinate.',
      {
        type: 'object',
        properties: pointTargetProperties(),
        required: [],
      },
      runComputer,
    ),
    createComputerActionTool(
      'right_click',
      'right_click',
      'Right-click a page element or viewport coordinate.',
      {
        type: 'object',
        properties: pointTargetProperties(),
        required: [],
      },
      runComputer,
    ),
    createComputerActionTool(
      'double_click',
      'double_click',
      'Double-click a page element or viewport coordinate.',
      {
        type: 'object',
        properties: pointTargetProperties(),
        required: [],
      },
      runComputer,
    ),
    createComputerActionTool(
      'triple_click',
      'triple_click',
      'Triple-click a page element or viewport coordinate, usually to select a paragraph or field contents.',
      {
        type: 'object',
        properties: pointTargetProperties(),
        required: [],
      },
      runComputer,
    ),
    createComputerActionTool(
      'hover',
      'hover',
      'Move the mouse over a page element or viewport coordinate.',
      {
        type: 'object',
        properties: pointTargetProperties(),
        required: [],
      },
      runComputer,
    ),
    createComputerActionTool(
      'drag',
      'left_click_drag',
      'Drag from one viewport coordinate to another.',
      {
        type: 'object',
        properties: {
          start_coordinate: {
            type: 'array',
            description: 'Starting x/y viewport coordinate.',
            items: { type: 'number' },
            minItems: 2,
            maxItems: 2,
          },
          coordinate: {
            type: 'array',
            description: 'Ending x/y viewport coordinate.',
            items: { type: 'number' },
            minItems: 2,
            maxItems: 2,
          },
          tabId: {
            type: 'number',
            description: 'Browser tab id to control. Omit to use the active tab.',
          },
        },
        required: ['start_coordinate', 'coordinate'],
      },
      runComputer,
    ),
    createComputerActionTool(
      'scroll',
      'scroll',
      'Scroll the page in a direction. Use scroll_to when you need to bring a specific element into view.',
      {
        type: 'object',
        properties: {
          scroll_direction: {
            type: 'string',
            enum: ['up', 'down', 'left', 'right'],
            description: 'Scroll direction. Defaults to down.',
          },
          duration: {
            type: 'number',
            description:
              'Scroll magnitude in pixels. Omit for a normal page-sized scroll.',
          },
          tabId: {
            type: 'number',
            description: 'Browser tab id to control. Omit to use the active tab.',
          },
        },
        required: [],
      },
      runComputer,
    ),
    createComputerActionTool(
      'scroll_to',
      'scroll_to',
      'Scroll a page element or viewport coordinate into view.',
      {
        type: 'object',
        properties: {
          ...pointTargetProperties(),
          duration: {
            type: 'number',
            description:
              'Fallback scroll magnitude in pixels when a coordinate is used.',
          },
        },
        required: [],
      },
      runComputer,
    ),
    createComputerActionTool(
      'type_text',
      'type',
      'Type text into the active field, or focus a target element/coordinate first and then type.',
      {
        type: 'object',
        properties: {
          ...pointTargetProperties(),
          text: {
            type: 'string',
            description: 'Text to insert.',
          },
        },
        required: ['text'],
      },
      runComputer,
    ),
    createComputerActionTool(
      'press_key',
      'key',
      'Press a keyboard key such as Enter, Escape, Tab, ArrowDown, or Backspace.',
      {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Key name to press.',
          },
          modifiers: {
            type: 'number',
            description:
              'Optional Chrome debugger modifier bitmask for Shift/Control/Alt/Meta.',
          },
          tabId: {
            type: 'number',
            description: 'Browser tab id to control. Omit to use the active tab.',
          },
        },
        required: ['text'],
      },
      runComputer,
    ),
    createComputerActionTool(
      'set_zoom',
      'zoom',
      'Set the browser zoom factor for the current tab.',
      {
        type: 'object',
        properties: {
          duration: {
            type: 'number',
            description: 'Zoom factor, such as 1 for 100% or 1.25 for 125%.',
          },
          tabId: {
            type: 'number',
            description: 'Browser tab id to control. Omit to use the active tab.',
          },
        },
        required: ['duration'],
      },
      runComputer,
    ),
  ];
}

function createUploadImageTool(uploadImageImpl) {
  return makeTool(
    'upload_image',
    'Upload a local image to a file input or drag-and-drop target.',
    {
      type: 'object',
      properties: {
        imageId: {
          type: 'string',
          description: 'Identifier of a captured or user-provided image.',
        },
        ref: {
          type: 'string',
          description: 'Element ref for the upload/drop target.',
        },
        coordinate: {
          type: 'array',
          description:
            'Fallback x/y viewport coordinate for upload/drop target.',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
        },
        tabId: {
          type: 'number',
          description: 'Browser tab id containing the upload target.',
        },
        filename: {
          type: 'string',
          description: 'Suggested filename for the uploaded image.',
        },
      },
      required: ['imageId'],
    },
    async (input, context) => uploadImageImpl(input, context),
  );
}

function createWaitTool(waitImpl) {
  return makeTool(
    'wait',
    'Wait for a short period before continuing.',
    {
      type: 'object',
      properties: {
        duration: {
          type: 'number',
          description:
            'How long to wait. Values under 100 are treated as seconds; larger values are milliseconds.',
        },
      },
      required: [],
    },
    async (input, context) => waitImpl(input, context),
  );
}

function createShortcutsListTool(shortcutsListImpl) {
  return makeTool(
    'shortcuts_list',
    'List all available shortcuts and workflows.',
    { type: 'object', properties: {}, required: [] },
    async (input, context) => shortcutsListImpl(input, context),
  );
}

function createShortcutsExecuteTool(shortcutsExecuteImpl) {
  return makeTool(
    'shortcuts_execute',
    'Execute a shortcut or workflow in a sidepanel window.',
    {
      type: 'object',
      properties: {
        shortcutId: {
          type: 'string',
          description: 'Identifier of the shortcut or workflow to execute.',
        },
        command: {
          type: 'string',
          description: 'Optional command or argument for the shortcut.',
        },
      },
      required: [],
    },
    async (input, context) => shortcutsExecuteImpl(input, context),
  );
}

function createToolRegistry(impl = {}) {
  const passthrough = (name) =>
    impl[name] || (async () => ({ error: `${name} not implemented` }));

  const tools = [
    createTabsContextTool(
      impl.tabsContext ||
        (async () => ({ error: 'tabsContext not implemented' })),
    ),
    createTabControlTool(
      impl.tabControl ||
        (async () => ({ error: 'tabControl not implemented' })),
    ),
    createFunctionTool(
      'javascript_tool',
      'Execute JavaScript code in the context of the current page.',
      {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: "Must be set to 'javascript_exec'.",
          },
          text: {
            type: 'string',
            description:
              'JavaScript source code to execute in the page context.',
          },
          tabId: {
            type: 'number',
            description: 'Browser tab id in which to execute the JavaScript.',
          },
        },
        required: ['action', 'text', 'tabId'],
      },
      passthrough('javascriptTool'),
    ),
    createFunctionTool(
      'file_upload',
      'Upload local files to a page file input by element ref.',
      {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            description: 'Local filesystem paths to upload.',
            items: {
              type: 'string',
              description: 'Absolute or accessible local file path.',
            },
          },
          ref: {
            type: 'string',
            description: 'Element ref for the target file input.',
          },
          tabId: {
            type: 'number',
            description: 'Browser tab id containing the file input.',
          },
        },
        required: ['paths', 'ref', 'tabId'],
      },
      passthrough('fileUpload'),
    ),
    createReadPageTool(
      impl.readPage || (async () => ({ error: 'readPage not implemented' })),
    ),
    createFindTool(
      impl.find || (async () => ({ error: 'find not implemented' })),
    ),
    createFunctionTool(
      'form_input',
      'Set values in form elements using an element ref.',
      {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description: 'Element ref for the form field.',
          },
          value: {
            type: ['string', 'boolean', 'number'],
            description: 'Value to assign to the form field.',
          },
          tabId: {
            type: 'number',
            description: 'Browser tab id containing the form field.',
          },
        },
        required: ['ref', 'value', 'tabId'],
      },
      passthrough('formInput'),
    ),
    createFunctionTool(
      'get_page_text',
      'Extract raw page text content.',
      {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: 'Browser tab id to read text from.',
          },
          max_chars: {
            type: 'number',
            description: 'Maximum number of text characters to return.',
          },
        },
        required: ['tabId'],
      },
      passthrough('getPageText'),
    ),
    createFunctionTool(
      'navigate',
      'Navigate to a URL, or go forward/back in browser history.',
      {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description:
              "URL to navigate to, or the literal value 'back' or 'forward' for browser history.",
          },
          tabId: {
            type: 'number',
            description: 'Browser tab id to navigate.',
          },
          force: {
            type: 'boolean',
            description:
              'Reserved flag for callers that need to force navigation.',
          },
        },
        required: ['url', 'tabId'],
      },
      passthrough('navigate'),
    ),
    createFunctionTool(
      'read_console_messages',
      'Read browser console messages from a tab.',
      {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description:
              'Browser tab id whose console messages should be read.',
          },
          onlyErrors: {
            type: 'boolean',
            description: 'When true, return only error-like console entries.',
          },
          clear: {
            type: 'boolean',
            description: 'When true, clear stored messages after reading.',
          },
          pattern: {
            type: 'string',
            description:
              'Case-insensitive regular expression used to filter message text.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of recent messages to return.',
          },
        },
        required: ['tabId'],
      },
      passthrough('readConsoleMessages'),
    ),
    createFunctionTool(
      'read_network_requests',
      'Read HTTP network requests from a tab.',
      {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description:
              'Browser tab id whose network requests should be read.',
          },
          urlPattern: {
            type: 'string',
            description:
              'Case-insensitive regular expression used to filter request URLs.',
          },
          clear: {
            type: 'boolean',
            description: 'When true, clear stored requests after reading.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of recent requests to return.',
          },
        },
        required: ['tabId'],
      },
      passthrough('readNetworkRequests'),
    ),
    createFunctionTool(
      'resize_window',
      'Resize the current browser window.',
      {
        type: 'object',
        properties: {
          width: {
            type: 'number',
            description: 'Desired browser window width in pixels.',
          },
          height: {
            type: 'number',
            description: 'Desired browser window height in pixels.',
          },
          tabId: {
            type: 'number',
            description:
              'Browser tab id used to identify the window to resize.',
          },
        },
        required: ['width', 'height', 'tabId'],
      },
      passthrough('resizeWindow'),
    ),
    createFunctionTool(
      'tabs_create',
      'Creates a new empty tab in the current tab group.',
      { type: 'object', properties: {}, required: [] },
      passthrough('tabsCreate'),
    ),
    createFunctionTool(
      'turn_answer_start',
      'Call immediately before the text response for the turn.',
      { type: 'object', properties: {}, required: [] },
      passthrough('turnAnswerStart'),
    ),
    createFunctionTool(
      'update_plan',
      'Present a plan to the user for approval before taking actions.',
      {
        type: 'object',
        properties: {
          domains: {
            type: 'array',
            description: 'Relevant domains or sites involved in the plan.',
            items: { type: 'string', description: 'Domain or site name.' },
          },
          approach: {
            type: 'array',
            description: 'Ordered plan steps to present to the user.',
            items: { type: 'string', description: 'Plan step.' },
          },
        },
        required: ['domains', 'approach'],
      },
      passthrough('updatePlan'),
    ),
    ...createComputerActionTools(impl.computer),
    createWaitTool(
      impl.wait || (async () => ({ error: 'wait not implemented' })),
    ),
  ];

  if (impl.uploadImage) {
    tools.push(createUploadImageTool(impl.uploadImage));
  }
  if (impl.shortcutsList) {
    tools.push(createShortcutsListTool(impl.shortcutsList));
  }
  if (impl.shortcutsExecute) {
    tools.push(createShortcutsExecuteTool(impl.shortcutsExecute));
  }

  return tools.map((tool) => ({
    ...tool,
    input_schema: describeSchema(tool.input_schema),
  }));
}

async function executeToolCall(toolName, input, context, registry) {
  const tool = (registry || []).find((entry) => entry.name === toolName);
  if (!tool) throw new Error(`Unknown tool: ${toolName}`);
  return tool.execute(input, context);
}

async function buildOpenAIToolList(registry) {
  return collectOpenAISchemas(registry);
}

async function buildToolJson(registry) {
  return serializeToolJson(await buildOpenAIToolList(registry));
}

export {
  ELEMENT_MAP_KEY,
  ensureElementMap,
  createRefId,
  storeElementRef,
  resolveElementRef,
  removeElementRef,
  collectOpenAISchemas,
  serializeToolJson,
  parseFindOutput,
  stringifyRefMatches,
  dispatchMouseEvent,
  dispatchKeyEvent,
  clickAt,
  doubleClickAt,
  typeText,
  scrollBy,
  makeTool,
  createFunctionTool,
  createTabsContextTool,
  createTabControlTool,
  createReadPageTool,
  createFindTool,
  createComputerActionTools,
  createUploadImageTool,
  createWaitTool,
  createShortcutsListTool,
  createShortcutsExecuteTool,
  createToolRegistry,
  executeToolCall,
  buildOpenAIToolList,
  buildToolJson,
};
