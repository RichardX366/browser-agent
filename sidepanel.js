import {
  clickAt,
  createComputerTool,
  createFindTool,
  createReadPageTool,
  createRefId,
  createTabsContextTool,
  createToolRegistry,
  doubleClickAt,
  executeToolCall,
  scrollBy,
  stringifyRefMatches,
  typeText,
} from './helpers.js';

const STORAGE_KEY = 'openai-browser-agent.state';
const DEFAULT_PROVIDER = 'openai';
const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    apiKeyLabel: 'OpenAI API token',
    apiKeyPlaceholder: 'sk-...',
    defaultModel: 'gpt-5.4-mini',
    models: [
      'gpt-5.4-mini',
      'gpt-5.4',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
    ],
    endpoint: 'https://api.openai.com/v1/chat/completions',
    adapter: 'openai-compatible',
  },
  anthropic: {
    label: 'Anthropic',
    apiKeyLabel: 'Anthropic API token',
    apiKeyPlaceholder: 'sk-ant-...',
    defaultModel: 'claude-sonnet-4-5',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-3-5'],
    endpoint: 'https://api.anthropic.com/v1/messages',
    adapter: 'anthropic',
  },
  gemini: {
    label: 'Google Gemini',
    apiKeyLabel: 'Gemini API key',
    apiKeyPlaceholder: 'AIza...',
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    adapter: 'gemini',
  },
  mistral: {
    label: 'Mistral',
    apiKeyLabel: 'Mistral API key',
    apiKeyPlaceholder: '...',
    defaultModel: 'mistral-large-latest',
    models: [
      'mistral-large-latest',
      'mistral-medium-latest',
      'mistral-small-latest',
    ],
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
    adapter: 'openai-compatible',
  },
  kimi: {
    label: 'Kimi',
    apiKeyLabel: 'Moonshot API key',
    apiKeyPlaceholder: 'sk-...',
    defaultModel: 'kimi-k2.6',
    models: [
      'kimi-k2.6',
      'kimi-k2.5',
      'kimi-k2-turbo-preview',
      'kimi-k2-0905-preview',
      'moonshot-v1-128k',
    ],
    endpoint: 'https://api.moonshot.ai/v1/chat/completions',
    adapter: 'openai-compatible',
    omitTemperature: true,
  },
};
const DEFAULT_MODEL = PROVIDERS[DEFAULT_PROVIDER].defaultModel;
const SYSTEM_PROMPT = [
  "You are a browser agent controlling the user's current browser tab.",
  'Use browser tools to inspect the page, choose actions carefully, and explain only concise, observable reasoning when it helps the user follow along.',
  'If you need to inspect the page state, call the page-reading or tab-context tools first.',
  'When you make tool calls, keep the user-visible planning text short and practical.',
  'Never claim a browser action happened unless the corresponding tool call completed successfully.',
  'Surface tool calls, tool outputs, and any visible reasoning summaries in the transcript.',
].join(' ');

const state = {
  provider: DEFAULT_PROVIDER,
  apiKey: '',
  apiKeys: {},
  model: DEFAULT_MODEL,
  activeConversationId: null,
  conversations: [],
  isRunning: false,
  stopRequested: false,
  status: 'Idle',
  isDrawerOpen: false,
  conversationSearch: '',
};

const refStore = new Map();
let toolRegistry = [];
const compactLayoutQuery = window.matchMedia('(max-width: 1080px)');
const consoleMessageStore = new Map();
const networkRequestStore = new Map();
let debuggerEventListenerBound = false;

const elements = {
  sidebar: document.getElementById('sidebar'),
  drawerBackdrop: document.getElementById('drawerBackdrop'),
  conversationDrawerButton: document.getElementById('conversationDrawerButton'),
  conversationList: document.getElementById('conversationList'),
  conversationSearchInput: document.getElementById('conversationSearchInput'),
  newConversationButton: document.getElementById('newConversationButton'),
  settingsButton: document.getElementById('settingsButton'),
  closeSettingsButton: document.getElementById('closeSettingsButton'),
  chatPage: document.getElementById('chatPage'),
  settingsPage: document.getElementById('settingsPage'),
  providerSelect: document.getElementById('providerSelect'),
  apiKeyLabel: document.getElementById('apiKeyLabel'),
  apiKeyInput: document.getElementById('apiKeyInput'),
  modelSelect: document.getElementById('modelSelect'),
  customModelField: document.getElementById('customModelField'),
  customModelInput: document.getElementById('customModelInput'),
  clearConversationsButton: document.getElementById('clearConversationsButton'),
  statusPill: document.getElementById('statusPill'),
  transcript: document.getElementById('transcript'),
  composer: document.getElementById('composer'),
  promptInput: document.getElementById('promptInput'),
  sendButton: document.getElementById('sendButton'),
};

const SEND_ICON = `
  <svg fill="#fff" viewBox="0 0 32 32" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
    <path d="M27.71,4.29a1,1,0,0,0-1.05-.23l-22,8a1,1,0,0,0,0,1.87l8.59,3.43L19.59,11,21,12.41l-6.37,6.37,3.44,8.59A1,1,0,0,0,19,28h0a1,1,0,0,0,.92-.66l8-22A1,1,0,0,0,27.71,4.29Z"></path>
  </svg>
`;
const STOP_ICON = `
  <svg viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="9" fill="none" stroke="#fff" stroke-width="2"></circle>
    <rect x="9" y="9" width="6" height="6" rx="1" fill="#fff"></rect>
  </svg>
`;

function uid(prefix = 'msg') {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
  }
  return `${prefix}_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
}

function nowLabel(value = Date.now()) {
  return new Date(value).toLocaleString([], {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeJsonParse(value) {
  if (value == null || value === '') return null;
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return value;
  }
}

function truncateText(value, limit = 220) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trim()}…`;
}

function safeStringify(value, space = 2) {
  try {
    return JSON.stringify(value, null, space);
  } catch {
    return String(value);
  }
}

function getProvider(provider = state.provider) {
  return PROVIDERS[provider] || PROVIDERS[DEFAULT_PROVIDER];
}

function getProviderId(provider = state.provider) {
  return PROVIDERS[provider] ? provider : DEFAULT_PROVIDER;
}

function getProviderModelOptions(provider = state.provider) {
  return getProvider(provider).models || [];
}

function getDefaultModel(provider = state.provider) {
  return getProvider(provider).defaultModel || DEFAULT_MODEL;
}

function getCurrentApiKey() {
  const provider = getProviderId();
  return state.apiKeys?.[provider] || '';
}

function setCurrentApiKey(apiKey) {
  const provider = getProviderId();
  state.apiKey = apiKey;
  state.apiKeys = {
    ...(state.apiKeys || {}),
    [provider]: apiKey,
  };
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    state.provider = DEFAULT_PROVIDER;
    state.apiKey = '';
    state.apiKeys = {};
    state.model = DEFAULT_MODEL;
    state.conversations = [createConversation()];
    state.activeConversationId = state.conversations[0].id;
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    state.provider = getProviderId(parsed.provider || DEFAULT_PROVIDER);
    state.apiKeys =
      parsed.apiKeys && typeof parsed.apiKeys === 'object'
        ? parsed.apiKeys
        : {};
    if (parsed.apiKey && !state.apiKeys[state.provider]) {
      state.apiKeys[state.provider] = parsed.apiKey;
    }
    state.apiKey = state.apiKeys[state.provider] || parsed.apiKey || '';
    state.model = parsed.model || getDefaultModel(state.provider);
    state.conversations =
      Array.isArray(parsed.conversations) && parsed.conversations.length
        ? parsed.conversations
        : [createConversation()];
    state.activeConversationId =
      parsed.activeConversationId || state.conversations[0].id;
  } catch {
    state.provider = DEFAULT_PROVIDER;
    state.apiKey = '';
    state.apiKeys = {};
    state.model = DEFAULT_MODEL;
    state.conversations = [createConversation()];
    state.activeConversationId = state.conversations[0].id;
  }

  if (
    !state.conversations.some(
      (conversation) => conversation.id === state.activeConversationId,
    )
  ) {
    state.activeConversationId = state.conversations[0].id;
  }

  state.provider = getProviderId(state.provider);
  state.model = state.model || getDefaultModel(state.provider);
  state.apiKey = state.apiKeys?.[state.provider] || state.apiKey || '';
}

function persistState() {
  setCurrentApiKey(state.apiKey || '');
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      provider: state.provider,
      apiKey: state.apiKey,
      apiKeys: state.apiKeys,
      model: state.model,
      activeConversationId: state.activeConversationId,
      conversations: state.conversations,
    }),
  );
}

function createConversation(title = 'New conversation') {
  const createdAt = Date.now();
  return {
    id: uid('conversation'),
    title,
    createdAt,
    updatedAt: createdAt,
    provider: state.provider,
    model: getDefaultModel(state.provider),
    messages: [],
  };
}

function getConversation(conversationId = state.activeConversationId) {
  return (
    state.conversations.find(
      (conversation) => conversation.id === conversationId,
    ) || null
  );
}

function setStatus(text) {
  state.status = text;
  elements.statusPill.textContent = text;
  elements.statusPill.classList.toggle(
    'running',
    text === 'Running' || text === 'Stopping',
  );
  elements.statusPill.classList.toggle('error', text === 'Error');
}

function renderSendButton() {
  elements.sendButton.type = state.isRunning ? 'button' : 'submit';
  elements.sendButton.innerHTML = state.isRunning ? STOP_ICON : SEND_ICON;
  elements.sendButton.setAttribute(
    'aria-label',
    state.isRunning ? 'Stop conversation' : 'Send message',
  );
  elements.sendButton.title = state.isRunning ? 'Stop' : 'Send';
}

function renderDrawer() {
  const isCompactLayout = compactLayoutQuery.matches;
  document.body.classList.toggle('drawer-open', state.isDrawerOpen);
  elements.drawerBackdrop.hidden = !state.isDrawerOpen;
  elements.sidebar.inert = isCompactLayout && !state.isDrawerOpen;
  elements.sidebar.setAttribute(
    'aria-hidden',
    isCompactLayout && !state.isDrawerOpen ? 'true' : 'false',
  );
  elements.conversationDrawerButton.setAttribute(
    'aria-expanded',
    state.isDrawerOpen ? 'true' : 'false',
  );
}

function openConversationDrawer() {
  state.isDrawerOpen = true;
  renderDrawer();
}

function closeConversationDrawer() {
  state.isDrawerOpen = false;
  renderDrawer();
}

function setRunning(isRunning) {
  state.isRunning = isRunning;
  if (isRunning) {
    state.stopRequested = false;
  }
  elements.sendButton.disabled = false;
  renderSendButton();
  elements.newConversationButton.disabled = isRunning;
  elements.providerSelect.disabled = isRunning;
  elements.modelSelect.disabled = isRunning;
  elements.customModelInput.disabled = isRunning;
  elements.apiKeyInput.disabled = isRunning;
  elements.clearConversationsButton.disabled = isRunning;
  document
    .querySelectorAll('.conversation-delete')
    .forEach((button) => (button.disabled = isRunning));
  document
    .querySelectorAll('.conversation-select')
    .forEach((button) => (button.disabled = isRunning));
  document
    .querySelectorAll('.conversation-item')
    .forEach((item) => item.classList.toggle('disabled', isRunning));
}

function updateConversationModel(conversation) {
  conversation.provider = state.provider;
  conversation.model = state.model;
}

function renderModelControls() {
  const provider = getProvider();
  const modelOptions = getProviderModelOptions();
  elements.providerSelect.value = getProviderId();
  elements.apiKeyLabel.textContent = provider.apiKeyLabel;
  elements.apiKeyInput.placeholder = provider.apiKeyPlaceholder;
  elements.modelSelect.innerHTML = '';

  for (const model of modelOptions) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    elements.modelSelect.append(option);
  }

  const customOption = document.createElement('option');
  customOption.value = 'custom';
  customOption.textContent = 'Custom';
  elements.modelSelect.append(customOption);

  const isKnownModel = modelOptions.includes(state.model);
  elements.modelSelect.value = isKnownModel ? state.model : 'custom';
  elements.customModelField.hidden = isKnownModel;
  elements.customModelInput.value = isKnownModel ? '' : state.model;
}

function setProvider(provider) {
  state.provider = getProviderId(provider);
  state.apiKey = state.apiKeys?.[state.provider] || '';
  state.model = getDefaultModel(state.provider);
  const conversation = getActiveConversation();
  updateConversationModel(conversation);
  persistState();
  renderAll();
}

function setModel(model) {
  state.model = String(model || '').trim() || getDefaultModel();
  const conversation = getActiveConversation();
  updateConversationModel(conversation);
  persistState();
  renderModelControls();
  renderConversationList();
}

function getActiveConversation() {
  let conversation = getConversation();
  if (!conversation) {
    conversation = createConversation();
    state.conversations.unshift(conversation);
    state.activeConversationId = conversation.id;
  }
  return conversation;
}

function ensureDefaultConversation() {
  if (state.conversations.length === 0) {
    const conversation = createConversation();
    state.conversations = [conversation];
    state.activeConversationId = conversation.id;
  }
}

function createMessage(role, content, extras = {}) {
  return {
    id: uid(role),
    role,
    content: content || '',
    createdAt: Date.now(),
    ...extras,
  };
}

function updateConversationMeta(conversation, titleFromUser = '') {
  conversation.updatedAt = Date.now();
  if (titleFromUser && conversation.title === 'New conversation') {
    conversation.title = truncateText(titleFromUser, 42);
  }
  updateConversationModel(conversation);
}

function saveConversationMutation(conversation, mutator) {
  mutator(conversation);
  conversation.updatedAt = Date.now();
  persistState();
  renderAll();
}

function conversationSummary(conversation) {
  const lastMessage = [...conversation.messages]
    .reverse()
    .find((message) => message.role !== 'system');
  if (!lastMessage) return 'Empty';
  const prefix =
    lastMessage.role === 'user'
      ? 'You: '
      : lastMessage.role === 'assistant'
        ? 'Agent: '
        : `${lastMessage.name || 'Tool'}: `;
  return truncateText(`${prefix}${lastMessage.content || ''}`, 46);
}

function conversationMatchesSearch(conversation, query) {
  if (!query) return true;

  const providerLabel = getProvider(conversation.provider).label;
  const searchableText = [
    conversation.title,
    providerLabel,
    conversation.model || getDefaultModel(conversation.provider),
    conversationSummary(conversation),
    ...(conversation.messages || []).map((message) => message.content || ''),
  ]
    .join(' ')
    .toLowerCase();

  return searchableText.includes(query);
}

function renderConversationList() {
  elements.conversationList.innerHTML = '';

  const query = state.conversationSearch.trim().toLowerCase();
  const conversations = [...state.conversations]
    .filter((conversation) => conversationMatchesSearch(conversation, query))
    .sort((left, right) => right.updatedAt - left.updatedAt);

  if (query && conversations.length === 0) {
    const emptySearch = document.createElement('div');
    emptySearch.className = 'conversation-empty';
    emptySearch.textContent = 'No matching conversations';
    elements.conversationList.append(emptySearch);
    return;
  }

  for (const conversation of conversations) {
    const item = document.createElement('div');
    item.className = `conversation-item ${conversation.id === state.activeConversationId ? 'active' : ''}`;
    item.classList.toggle('disabled', state.isRunning);
    item.dataset.conversationId = conversation.id;

    const selectButton = document.createElement('button');
    selectButton.type = 'button';
    selectButton.className = 'conversation-select';
    selectButton.disabled = state.isRunning;
    selectButton.setAttribute(
      'aria-current',
      conversation.id === state.activeConversationId ? 'true' : 'false',
    );

    const title = document.createElement('div');
    title.className = 'conversation-title';
    title.textContent = conversation.title;

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'conversation-delete';
    deleteButton.disabled = state.isRunning;
    deleteButton.setAttribute('aria-label', `Delete ${conversation.title}`);
    deleteButton.title = 'Delete conversation';
    deleteButton.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 6h18"></path>
        <path d="M8 6V4h8v2"></path>
        <path d="M19 6l-1 14H6L5 6"></path>
        <path d="M10 11v6"></path>
        <path d="M14 11v6"></path>
      </svg>
    `;

    const meta = document.createElement('div');
    meta.className = 'conversation-meta';
    meta.innerHTML = `<span>${conversation.messages.length} messages</span><span>${nowLabel(conversation.updatedAt)}</span>`;

    const summary = document.createElement('div');
    summary.className = 'conversation-meta';
    summary.textContent = conversationSummary(conversation);

    selectButton.append(title, meta, summary);
    item.append(selectButton, deleteButton);
    selectButton.addEventListener('click', () => {
      if (state.isRunning) return;
      selectConversation(conversation.id);
    });
    deleteButton.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteConversation(conversation.id);
    });

    elements.conversationList.append(item);
  }
}

function renderToolCall(call, response = null) {
  const wrapper = document.createElement('details');
  wrapper.className = 'tool-call tool-collapsible';

  const header = document.createElement('summary');
  header.className = 'tool-call-title';
  header.textContent = call.name || response?.name || 'tool';

  const args = document.createElement('pre');
  args.className = 'tool-arguments';
  args.textContent = safeJsonParse(call.arguments)
    ? safeStringify(safeJsonParse(call.arguments))
    : String(call.arguments || '{}');

  const argsBlock = document.createElement('div');
  argsBlock.className = 'tool-call-section';

  const argsLabel = document.createElement('div');
  argsLabel.className = 'tool-call-label';
  argsLabel.textContent = 'Input';
  argsBlock.append(argsLabel, args);

  wrapper.append(header, argsBlock);

  if (response) {
    const outputBlock = document.createElement('div');
    outputBlock.className = 'tool-call-section tool-call-response';

    const outputLabel = document.createElement('div');
    outputLabel.className = 'tool-call-label';
    outputLabel.textContent = 'Output';

    const output = document.createElement('div');
    output.className = 'tool-output';
    output.textContent =
      typeof response.content === 'string'
        ? response.content
        : safeStringify(response.content);

    outputBlock.append(outputLabel, output);
    wrapper.append(outputBlock);
  }

  return wrapper;
}

function findToolResponse(messages, call) {
  return (
    messages.find(
      (message) =>
        message.role === 'tool' &&
        message.tool_call_id &&
        message.tool_call_id === call.id,
    ) || null
  );
}

function renderMessage(message, messages = []) {
  const article = document.createElement('article');
  article.className = `message ${message.role}`;
  article.dataset.messageId = message.id || '';

  if (message.role === 'tool') {
    article.append(
      renderToolCall(
        {
          name: message.name || 'tool',
          arguments: {},
        },
        message,
      ),
    );
    return article;
  }

  const body = document.createElement('div');
  body.className = 'message-content';
  body.innerHTML = escapeHtml(message.content || '').replace(/\n/g, '<br />');

  if (message.role === 'user') {
    article.className = 'message user-message';
    const bubble = document.createElement('div');
    bubble.className = 'user-message-bubble';
    bubble.append(body);

    const actions = document.createElement('div');
    actions.className = 'message-actions';

    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'message-edit-button';
    editButton.disabled = state.isRunning;
    editButton.title = 'Edit message';
    editButton.setAttribute('aria-label', 'Edit message');
    editButton.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 20h9"></path>
        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
      </svg>
    `;
    editButton.addEventListener('click', () => {
      editUserMessage(message.id);
    });
    actions.append(editButton);
    article.append(bubble, actions);
    return article;
  }

  if (message.role === 'assistant' && message.tool_calls?.length) {
    if (message.content?.trim()) {
      const thinking = document.createElement('details');
      thinking.className = 'thinking';

      const summary = document.createElement('summary');
      summary.textContent = 'Thinking';

      const thinkingContent = document.createElement('div');
      thinkingContent.className = 'thinking-content';
      thinkingContent.innerHTML = escapeHtml(message.content).replace(
        /\n/g,
        '<br />',
      );

      thinking.append(summary, thinkingContent);
      article.append(thinking);
    }

    const toolCalls = document.createElement('div');
    toolCalls.className = 'tool-calls';
    for (const call of message.tool_calls) {
      toolCalls.append(renderToolCall(call, findToolResponse(messages, call)));
    }
    article.append(toolCalls);
    return article;
  }

  article.append(body);
  return article;
}

function renderTranscript() {
  elements.transcript.innerHTML = '';
  const conversation = getActiveConversation();

  if (!conversation || conversation.messages.length === 0) {
    const placeholder = document.createElement('div');
    placeholder.className = 'empty-state';
    placeholder.innerHTML =
      '<div><strong>Start a conversation</strong><br />Ask the agent to inspect the current page, click something, or type for you.</div>';
    elements.transcript.append(placeholder);
    return;
  }

  const pairedToolCallIds = new Set(
    conversation.messages.flatMap((message) =>
      message.role === 'assistant' && Array.isArray(message.tool_calls)
        ? message.tool_calls.map((call) => call.id).filter(Boolean)
        : [],
    ),
  );

  let previousVisibleMessage = null;
  for (const message of conversation.messages) {
    if (
      message.role === 'tool' &&
      message.tool_call_id &&
      pairedToolCallIds.has(message.tool_call_id)
    ) {
      continue;
    }

    const renderedMessage = renderMessage(message, conversation.messages);
    if (
      message.role === 'assistant' &&
      (previousVisibleMessage?.role === 'assistant' ||
        previousVisibleMessage?.role === 'tool')
    ) {
      renderedMessage.classList.add('agent-continuation');
    }
    elements.transcript.append(renderedMessage);
    previousVisibleMessage = message;
  }

  elements.transcript.scrollTop = elements.transcript.scrollHeight;
}

function renderAll() {
  ensureDefaultConversation();
  state.apiKey = getCurrentApiKey();
  elements.conversationSearchInput.value = state.conversationSearch;
  elements.apiKeyInput.value = state.apiKey;
  renderModelControls();
  renderConversationList();
  renderTranscript();
  renderDrawer();
  renderSendButton();
}

function selectConversation(conversationId) {
  state.activeConversationId = conversationId;
  const conversation = getConversation(conversationId);
  if (conversation?.provider) {
    state.provider = getProviderId(conversation.provider);
  }
  if (conversation?.model) {
    state.model = conversation.model;
  } else {
    state.model = getDefaultModel(state.provider);
  }
  state.apiKey = getCurrentApiKey();
  persistState();
  renderAll();
  showChatPage();
  closeConversationDrawer();
}

function newConversation() {
  state.conversationSearch = '';
  const conversation = createConversation();
  conversation.provider = state.provider;
  conversation.model = state.model;
  state.conversations.unshift(conversation);
  state.activeConversationId = conversation.id;
  persistState();
  renderAll();
  showChatPage();
  closeConversationDrawer();
}

function showSettingsPage() {
  elements.chatPage.hidden = true;
  elements.settingsPage.hidden = false;
  elements.settingsButton.setAttribute('aria-pressed', 'true');
  closeConversationDrawer();
  elements.apiKeyInput.focus();
}

function showChatPage() {
  elements.settingsPage.hidden = true;
  elements.chatPage.hidden = false;
  elements.settingsButton.setAttribute('aria-pressed', 'false');
  elements.promptInput.focus();
}

function deleteConversation(conversationId = state.activeConversationId) {
  if (state.isRunning) return;
  const conversation = getConversation(conversationId);
  if (!conversation) return;

  const shouldDelete = confirm(
    `Delete conversation \"${conversation.title}\"?`,
  );
  if (!shouldDelete) return;

  state.conversations = state.conversations.filter(
    (entry) => entry.id !== conversationId,
  );
  if (state.conversations.length === 0) {
    state.conversations = [createConversation()];
  }
  if (state.activeConversationId === conversationId) {
    state.activeConversationId = [...state.conversations].sort(
      (left, right) => right.updatedAt - left.updatedAt,
    )[0].id;
  }
  persistState();
  renderAll();
}

function clearAllConversations() {
  if (state.isRunning) return;
  const shouldClear = confirm(
    'Clear all conversations? This keeps your provider settings and API keys.',
  );
  if (!shouldClear) return;

  const conversation = createConversation();
  conversation.provider = state.provider;
  conversation.model = state.model;
  state.conversations = [conversation];
  state.activeConversationId = conversation.id;
  persistState();
  renderAll();
  showChatPage();
}

async function editUserMessage(messageId) {
  if (state.isRunning || !messageId) return;

  const conversation = getActiveConversation();
  const messageIndex = conversation.messages.findIndex(
    (message) => message.id === messageId && message.role === 'user',
  );
  if (messageIndex === -1) return;

  const originalMessage = conversation.messages[messageIndex];
  const editedContent = prompt('Edit message', originalMessage.content || '');
  if (editedContent == null) return;

  const nextContent = editedContent.trim();
  if (!nextContent || nextContent === originalMessage.content) return;

  const willDiscardHistory = messageIndex < conversation.messages.length - 1;
  const shouldEdit = confirm(
    willDiscardHistory
      ? 'Save this edit and discard everything after this message?'
      : 'Save this edit and rerun from this message?',
  );
  if (!shouldEdit) return;

  conversation.messages = conversation.messages.slice(0, messageIndex + 1);
  conversation.messages[messageIndex] = {
    ...originalMessage,
    content: nextContent,
    editedAt: Date.now(),
  };
  conversation.updatedAt = Date.now();

  const firstUserMessage = conversation.messages.find(
    (message) => message.role === 'user',
  );
  if (firstUserMessage?.id === messageId) {
    conversation.title = truncateText(nextContent, 42);
  }

  updateConversationModel(conversation);
  persistState();
  renderAll();

  try {
    await runConversation(conversation.id);
  } catch {
    // The error is already surfaced in the transcript.
  }
}

function appendMessage(conversationId, message) {
  const conversation = getConversation(conversationId);
  if (!conversation) throw new Error('Conversation not found.');
  conversation.messages.push(message);
  conversation.updatedAt = Date.now();
  if (message.role === 'user' && conversation.title === 'New conversation') {
    conversation.title = truncateText(message.content, 42);
  }
  persistState();
  renderAll();
}

function updateLastAssistantMessage(conversationId, updater) {
  const conversation = getConversation(conversationId);
  if (!conversation) throw new Error('Conversation not found.');
  const message = [...conversation.messages]
    .reverse()
    .find((entry) => entry.role === 'assistant');
  if (!message) return null;
  updater(message);
  conversation.updatedAt = Date.now();
  persistState();
  renderAll();
  return message;
}

function normalizeToolResult(result) {
  if (typeof result === 'string') return result;
  const text = safeStringify(result, 2);
  return truncateText(text, 7000);
}

function toolRegistryContext(conversationId) {
  return {
    conversationId,
    getActiveConversation: () => getConversation(conversationId),
    resolveRef: (refId) => refStore.get(refId) || null,
    storeRef: (refId, value) => {
      refStore.set(refId, value);
    },
  };
}

async function getCurrentTab(tabId) {
  if (typeof tabId === 'number' && tabId > 0) {
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      // Fall back to the active tab if the model supplied a stale tab id.
    }
  }

  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!tab) {
    throw new Error('No active tab found.');
  }
  return tab;
}

async function ensureDebugger(tabId) {
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const error = chrome.runtime.lastError;
      if (error) {
        const message = String(error.message || error);
        if (
          !message.includes('Another debugger is already attached') &&
          !message.includes('Cannot attach to this target')
        ) {
          reject(new Error(message));
          return;
        }
      }
      resolve();
    });
  });

  bindDebuggerEventListener();
}

function pushStoreEntry(store, tabId, entry, limit = 500) {
  const entries = store.get(tabId) || [];
  entries.push({ ...entry, createdAt: Date.now() });
  if (entries.length > limit) {
    entries.splice(0, entries.length - limit);
  }
  store.set(tabId, entries);
}

function bindDebuggerEventListener() {
  if (debuggerEventListenerBound) return;
  debuggerEventListenerBound = true;

  chrome.debugger.onEvent.addListener((source, method, params = {}) => {
    if (!source?.tabId) return;

    if (method === 'Log.entryAdded') {
      const entry = params.entry || {};
      pushStoreEntry(consoleMessageStore, source.tabId, {
        type: entry.level || 'log',
        text: entry.text || '',
        url: entry.url || '',
        lineNumber: entry.lineNumber,
        source: entry.source || 'log',
      });
    }

    if (method === 'Runtime.consoleAPICalled') {
      pushStoreEntry(consoleMessageStore, source.tabId, {
        type: params.type || 'log',
        text: (params.args || [])
          .map((arg) => arg.value ?? arg.description ?? arg.type ?? '')
          .join(' '),
        source: 'console',
      });
    }

    if (method === 'Network.requestWillBeSent') {
      pushStoreEntry(networkRequestStore, source.tabId, {
        requestId: params.requestId,
        url: params.request?.url || '',
        method: params.request?.method || '',
        type: params.type || '',
        initiator: params.initiator?.type || '',
      });
    }
  });
}

async function sendDebuggerCommand(tabId, method, params = {}) {
  await ensureDebugger(tabId);
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result ?? true);
    });
  });
}

async function queryElementGeometry(tabId, selector) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [selector],
    func: (querySelector) => {
      const element = document.querySelector(querySelector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        rect: {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };
    },
  });

  return results?.[0]?.result || null;
}

async function focusSelector(tabId, selector) {
  await chrome.scripting.executeScript({
    target: { tabId },
    args: [selector],
    func: (querySelector) => {
      const element = document.querySelector(querySelector);
      if (!element) return false;
      element.focus?.();
      element.scrollIntoView?.({ block: 'center', inline: 'center' });
      return true;
    },
  });
}

async function capturePageSnapshot(
  tabId,
  { filter = 'interactive', refId = null, maxChars = 8000 } = {},
) {
  const ref = refId ? refStore.get(refId) : null;
  const selector = ref?.selector || null;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [filter, selector, maxChars],
    func: (snapshotFilter, rootSelector, textLimit) => {
      const cssEscape =
        window.CSS?.escape ||
        ((value) => String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));

      function buildSelector(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) return '';
        if (element.id) return `#${cssEscape(element.id)}`;

        const parts = [];
        let node = element;

        while (node && node !== document.body) {
          let part = node.tagName.toLowerCase();
          if (node.classList && node.classList.length) {
            const classes = Array.from(node.classList)
              .slice(0, 2)
              .map((item) => cssEscape(item));
            if (classes.length) {
              part += `.${classes.join('.')}`;
            }
          }

          const parent = node.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter(
              (child) => child.tagName === node.tagName,
            );
            if (siblings.length > 1) {
              part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
            }
          }

          parts.unshift(part);
          node = parent;
        }

        return parts.join(' > ');
      }

      function isVisible(element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          rect.bottom >= 0 &&
          rect.right >= 0 &&
          rect.top <= window.innerHeight &&
          rect.left <= window.innerWidth
        );
      }

      function describeElement(element) {
        const rect = element.getBoundingClientRect();
        const text = (
          element.innerText ||
          element.value ||
          element.getAttribute('aria-label') ||
          element.getAttribute('placeholder') ||
          element.textContent ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim();
        const ariaLabel = element.getAttribute('aria-label') || '';
        const role = element.getAttribute('role') || '';
        const tag = element.tagName.toLowerCase();
        return {
          selector: buildSelector(element),
          tag,
          role,
          text: text.slice(0, 220),
          ariaLabel,
          href: element.href || '',
          value:
            typeof element.value === 'string'
              ? element.value.slice(0, 220)
              : '',
          type: element.type || '',
          checked: Boolean(element.checked),
          disabled: Boolean(element.disabled),
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          bounds: {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      }

      const root = rootSelector
        ? document.querySelector(rootSelector)
        : document.body;
      if (!root) {
        return {
          error: 'Root element not found',
          title: document.title,
          url: location.href,
          elements: [],
          text: '',
        };
      }

      const selectorList =
        snapshotFilter === 'interactive'
          ? 'a[href], button, input, textarea, select, summary, [role="button"], [role="link"], [role="textbox"], [role="option"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])'
          : 'a[href], button, input, textarea, select, summary, details, h1, h2, h3, h4, h5, h6, p, li, label, [role], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

      const elements = Array.from(root.querySelectorAll(selectorList))
        .filter(isVisible)
        .slice(0, 80)
        .map(describeElement);

      const text = (root.innerText || root.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, textLimit);
      return {
        title: document.title,
        url: location.href,
        text,
        elements,
        focused: describeElement(document.activeElement || document.body),
      };
    },
  });

  return results?.[0]?.result || null;
}

function registerSnapshotRefs(tabId, snapshot) {
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : [];
  return elements.map((element) => {
    const ref = createRefId('ref');
    refStore.set(ref, {
      tabId,
      selector: element.selector,
      label: element.text || element.ariaLabel || element.tag,
    });
    return {
      ...element,
      ref,
    };
  });
}

function summarizeSnapshot(snapshot, filter, tab) {
  const elements = registerSnapshotRefs(tab.id, snapshot);
  return {
    title: snapshot?.title || tab.title || '',
    url: snapshot?.url || tab.url || '',
    tabId: tab.id,
    filter,
    text: snapshot?.text || '',
    focused: snapshot?.focused || null,
    elements,
  };
}

async function tabsContext(input = {}) {
  const tab = await getCurrentTab(input.tabId);
  const tabs = await chrome.tabs.query({ currentWindow: true });

  return {
    activeTab: {
      id: tab.id,
      index: tab.index,
      title: tab.title,
      url: tab.url,
      status: tab.status,
      pinned: tab.pinned,
    },
    tabs: tabs.map((entry) => ({
      id: entry.id,
      index: entry.index,
      title: entry.title,
      url: entry.url,
      active: entry.active,
      status: entry.status,
      pinned: entry.pinned,
      groupId: entry.groupId,
    })),
  };
}

function normalizeUrl(value) {
  const url = String(value || '').trim();
  if (!url) {
    throw new Error('url is required.');
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    return url;
  }
  return `https://${url}`;
}

async function getTabByIndex(index) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const tab = tabs.find((entry) => entry.index === Number(index));
  if (!tab) {
    throw new Error(`No tab at index: ${index}.`);
  }
  return tab;
}

function summarizeTab(tab) {
  return {
    id: tab.id,
    index: tab.index,
    title: tab.title,
    url: tab.url,
    active: tab.active,
    status: tab.status,
    pinned: tab.pinned,
  };
}

async function javascriptTool(input = {}) {
  if (input.action && input.action !== 'javascript_exec') {
    throw new Error("javascript_tool action must be 'javascript_exec'.");
  }
  const tab = await getCurrentTab(input.tabId);
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [String(input.text || '')],
    func: (source) => {
      const value = globalThis.eval(source);
      return value === undefined ? null : JSON.parse(JSON.stringify(value));
    },
  });
  return { ok: true, result };
}

function getRefOrThrow(refId) {
  const ref = refStore.get(refId);
  if (!ref) {
    throw new Error(`Unknown ref: ${refId}`);
  }
  return ref;
}

async function formInput(input = {}) {
  const tab = await getCurrentTab(input.tabId);
  const ref = getRefOrThrow(input.ref);
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: ref.tabId || tab.id },
    args: [ref.selector, input.value],
    func: (selector, value) => {
      const element = document.querySelector(selector);
      if (!element) return { ok: false, error: 'Element not found.' };

      if (element.type === 'checkbox' || element.type === 'radio') {
        element.checked = Boolean(value);
      } else {
        element.value = String(value ?? '');
      }

      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    },
  });
  if (result?.error) throw new Error(result.error);
  return result || { ok: true };
}

async function getPageText(input = {}) {
  const tab = await getCurrentTab(input.tabId);
  const maxChars = Math.max(0, Number(input.max_chars) || 12000);
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [maxChars],
    func: (limit) => {
      const text =
        document.body?.innerText || document.documentElement?.textContent || '';
      return text.slice(0, limit);
    },
  });
  return { tabId: tab.id, text: result || '' };
}

async function fileUpload(input = {}) {
  if (!Array.isArray(input.paths) || input.paths.length === 0) {
    throw new Error('paths is required.');
  }
  const tab = await getCurrentTab(input.tabId);
  const ref = getRefOrThrow(input.ref);
  const documentResult = await sendDebuggerCommand(
    ref.tabId || tab.id,
    'DOM.getDocument',
    { depth: -1, pierce: true },
  );
  const queryResult = await sendDebuggerCommand(
    ref.tabId || tab.id,
    'DOM.querySelector',
    {
      nodeId: documentResult.root.nodeId,
      selector: ref.selector,
    },
  );
  if (!queryResult?.nodeId) {
    throw new Error('File input element not found.');
  }
  await sendDebuggerCommand(ref.tabId || tab.id, 'DOM.setFileInputFiles', {
    nodeId: queryResult.nodeId,
    files: input.paths.map(String),
  });
  return { ok: true, uploaded: input.paths.length };
}

async function getNavigationHistoryState(tabId) {
  const tab = await getCurrentTab(tabId);
  try {
    const history = await sendDebuggerCommand(
      tab.id,
      'Page.getNavigationHistory',
    );
    const currentIndex = Number(history?.currentIndex);
    const entries = Array.isArray(history?.entries) ? history.entries : [];
    return {
      tab,
      currentIndex,
      entries,
      canGoBack: currentIndex > 0,
      canGoForward:
        Number.isFinite(currentIndex) && currentIndex < entries.length - 1,
    };
  } catch {
    return {
      tab,
      currentIndex: -1,
      entries: [],
      canGoBack: false,
      canGoForward: false,
    };
  }
}

async function navigateHistory(input = {}, direction) {
  const history = await getNavigationHistoryState(input.tabId);
  const targetIndex =
    direction === 'back' ? history.currentIndex - 1 : history.currentIndex + 1;
  const targetEntry = history.entries[targetIndex];

  if (!targetEntry) {
    throw new Error(`Cannot go ${direction} in this tab.`);
  }

  await sendDebuggerCommand(history.tab.id, 'Page.navigateToHistoryEntry', {
    entryId: targetEntry.id,
  });

  return {
    ok: true,
    action: direction,
    tab: summarizeTab(history.tab),
    target: {
      id: targetEntry.id,
      title: targetEntry.title,
      url: targetEntry.url,
    },
  };
}

async function tabControl(input = {}) {
  const action = String(input.action || '').toLowerCase();

  if (action === 'open') {
    const tab = await chrome.tabs.create({
      url: normalizeUrl(input.url),
      active: input.active !== false,
    });
    return { ok: true, action, tab: summarizeTab(tab) };
  }

  if (action === 'navigate') {
    const currentTab = await getCurrentTab(input.tabId);
    const tab = await chrome.tabs.update(currentTab.id, {
      url: normalizeUrl(input.url),
      active: true,
    });
    return { ok: true, action, tab: summarizeTab(tab) };
  }

  if (action === 'switch') {
    const targetTab =
      typeof input.tabId === 'number'
        ? await getCurrentTab(input.tabId)
        : await getTabByIndex(input.index);
    const tab = await chrome.tabs.update(targetTab.id, { active: true });
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return { ok: true, action, tab: summarizeTab(tab) };
  }

  if (action === 'close') {
    const targetTab =
      typeof input.tabId === 'number'
        ? await getCurrentTab(input.tabId)
        : await getCurrentTab();
    await chrome.tabs.remove(targetTab.id);
    return { ok: true, action, closedTabId: targetTab.id };
  }

  if (action === 'back' || action === 'forward') {
    return navigateHistory(input, action);
  }

  return {
    error:
      'Unsupported tab_control action. Use open, navigate, switch, close, back, or forward.',
  };
}

async function navigate(input = {}) {
  const url = String(input.url || '')
    .trim()
    .toLowerCase();
  if (url === 'back') {
    return tabControl({ action: 'back', tabId: input.tabId });
  }
  if (url === 'forward') {
    return tabControl({ action: 'forward', tabId: input.tabId });
  }
  return tabControl({
    action: 'navigate',
    tabId: input.tabId,
    url: input.url,
  });
}

async function tabsCreate() {
  const tab = await chrome.tabs.create({ active: true });
  return { ok: true, action: 'open', tab: summarizeTab(tab) };
}

async function resizeWindow(input = {}) {
  const tab = await getCurrentTab(input.tabId);
  const width = Math.max(100, Math.round(Number(input.width) || 0));
  const height = Math.max(100, Math.round(Number(input.height) || 0));
  if (!width || !height) {
    throw new Error('width and height are required.');
  }
  await chrome.windows.update(tab.windowId, { width, height });
  return { ok: true, width, height, windowId: tab.windowId };
}

async function readConsoleMessages(input = {}) {
  const tab = await getCurrentTab(input.tabId);
  await sendDebuggerCommand(tab.id, 'Runtime.enable').catch(() => null);
  await sendDebuggerCommand(tab.id, 'Log.enable').catch(() => null);

  let messages = [...(consoleMessageStore.get(tab.id) || [])];
  if (input.onlyErrors) {
    messages = messages.filter((message) =>
      ['error', 'assert', 'exception'].includes(
        String(message.type).toLowerCase(),
      ),
    );
  }
  if (input.pattern) {
    const pattern = new RegExp(input.pattern, 'i');
    messages = messages.filter((message) => pattern.test(message.text || ''));
  }
  messages = messages.slice(-Math.max(1, Number(input.limit) || 100));
  if (input.clear) consoleMessageStore.set(tab.id, []);
  return { tabId: tab.id, messages };
}

async function readNetworkRequests(input = {}) {
  const tab = await getCurrentTab(input.tabId);
  await sendDebuggerCommand(tab.id, 'Network.enable').catch(() => null);

  let requests = [...(networkRequestStore.get(tab.id) || [])];
  if (input.urlPattern) {
    const pattern = new RegExp(input.urlPattern, 'i');
    requests = requests.filter((request) => pattern.test(request.url || ''));
  }
  requests = requests.slice(-Math.max(1, Number(input.limit) || 100));
  if (input.clear) networkRequestStore.set(tab.id, []);
  return { tabId: tab.id, requests };
}

async function readPage(input = {}) {
  const tab = await getCurrentTab(input.tabId);
  const snapshot = await capturePageSnapshot(tab.id, {
    filter: input.filter || 'interactive',
    refId: input.ref_id || null,
    maxChars: input.max_chars || 8000,
  });

  if (!snapshot) {
    return { error: 'Could not read the page.' };
  }

  if (snapshot.error) {
    return snapshot;
  }

  return summarizeSnapshot(snapshot, input.filter || 'interactive', tab);
}

async function findElements(input = {}) {
  if (!input.query?.trim()) {
    return { error: 'query is required' };
  }

  const tab = await getCurrentTab(input.tabId);
  const snapshot = await capturePageSnapshot(tab.id, {
    filter: 'all',
    maxChars: input.max_chars || 8000,
  });
  if (!snapshot || snapshot.error) {
    return snapshot || { error: 'Could not read the page.' };
  }

  const query = input.query.trim().toLowerCase();
  const matches = registerSnapshotRefs(tab.id, snapshot)
    .filter((element) => {
      const haystack = [
        element.text,
        element.ariaLabel,
        element.tag,
        element.role,
        element.href,
        element.value,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    })
    .slice(0, 20);

  return {
    query: input.query,
    tabId: tab.id,
    found: matches.length,
    matches,
    summary: stringifyRefMatches(
      matches.map((match) => ({
        ref: match.ref,
        role: match.role || match.tag,
        name: match.text || match.ariaLabel || match.tag,
        type: match.type || '',
        description: match.href || match.value || '',
      })),
    ),
  };
}

async function resolvePointFromInput(tabId, input) {
  if (Array.isArray(input.coordinate) && input.coordinate.length >= 2) {
    return { x: Number(input.coordinate[0]), y: Number(input.coordinate[1]) };
  }

  if (input.ref) {
    const ref = refStore.get(input.ref);
    if (!ref) {
      throw new Error(`Unknown ref: ${input.ref}`);
    }

    const geometry = await queryElementGeometry(
      ref.tabId || tabId,
      ref.selector,
    );
    if (!geometry) {
      throw new Error(`Could not resolve ref: ${input.ref}`);
    }
    return geometry;
  }

  throw new Error('A coordinate or ref is required for this action.');
}

async function sendKeyEvent(tabId, key, modifiers = 0) {
  await sendDebuggerCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    windowsVirtualKeyCode:
      key?.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
    modifiers,
  });
  await sendDebuggerCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    windowsVirtualKeyCode:
      key?.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
    modifiers,
  });
}

async function computer(input = {}) {
  if (!input.action) {
    return { error: 'action is required' };
  }

  const tab = await getCurrentTab(input.tabId);
  const debuggerApi = {
    sendCommand: sendDebuggerCommand,
  };

  const action = input.action;

  if (action === 'wait') {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Number(input.duration) || 1000)),
    );
    return { ok: true, waitedMs: Math.max(0, Number(input.duration) || 1000) };
  }

  if (action === 'scroll_to') {
    if (input.ref) {
      const ref = refStore.get(input.ref);
      if (!ref) {
        throw new Error(`Unknown ref: ${input.ref}`);
      }
      await chrome.scripting.executeScript({
        target: { tabId: ref.tabId || tab.id },
        args: [ref.selector],
        func: (querySelector) => {
          const element = document.querySelector(querySelector);
          if (!element) return false;
          element.scrollIntoView({
            block: 'center',
            inline: 'center',
            behavior: 'instant',
          });
          return true;
        },
      });
      return { ok: true, action, ref: input.ref };
    }

    const point = await resolvePointFromInput(tab.id, input);
    await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX: 0,
      deltaY: Math.max(0, Number(input.duration) || 600),
    });
    return { ok: true, action, point };
  }

  const point = await resolvePointFromInput(tab.id, input).catch(() => null);

  if (action === 'left_click') {
    if (!point)
      throw new Error('A coordinate or ref is required for left_click.');
    await clickAt(tab.id, debuggerApi, point.x, point.y);
    return { ok: true, action, point };
  }

  if (action === 'right_click') {
    if (!point)
      throw new Error('A coordinate or ref is required for right_click.');
    await clickAt(tab.id, debuggerApi, point.x, point.y, { button: 'right' });
    return { ok: true, action, point };
  }

  if (action === 'double_click') {
    if (!point)
      throw new Error('A coordinate or ref is required for double_click.');
    await doubleClickAt(tab.id, debuggerApi, point.x, point.y);
    return { ok: true, action, point };
  }

  if (action === 'triple_click') {
    if (!point)
      throw new Error('A coordinate or ref is required for triple_click.');
    await clickAt(tab.id, debuggerApi, point.x, point.y, { clickCount: 3 });
    return { ok: true, action, point };
  }

  if (action === 'hover') {
    if (!point) throw new Error('A coordinate or ref is required for hover.');
    await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
    });
    return { ok: true, action, point };
  }

  if (action === 'left_click_drag') {
    if (
      !Array.isArray(input.start_coordinate) ||
      input.start_coordinate.length < 2 ||
      !Array.isArray(input.coordinate) ||
      input.coordinate.length < 2
    ) {
      throw new Error(
        'start_coordinate and coordinate are required for left_click_drag.',
      );
    }

    const start = {
      x: Number(input.start_coordinate[0]),
      y: Number(input.start_coordinate[1]),
    };
    const end = {
      x: Number(input.coordinate[0]),
      y: Number(input.coordinate[1]),
    };
    await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: start.x,
      y: start.y,
      button: 'left',
    });
    await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: end.x,
      y: end.y,
      button: 'left',
    });
    await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: end.x,
      y: end.y,
      button: 'left',
    });
    return { ok: true, action, start, end };
  }

  if (action === 'scroll') {
    if (!point) {
      throw new Error('A coordinate or ref is required for scroll.');
    }

    const direction = String(input.scroll_direction || 'down').toLowerCase();
    const magnitude = Math.max(120, Math.abs(Number(input.duration) || 600));
    const deltaMap = {
      up: { deltaX: 0, deltaY: -magnitude },
      down: { deltaX: 0, deltaY: magnitude },
      left: { deltaX: -magnitude, deltaY: 0 },
      right: { deltaX: magnitude, deltaY: 0 },
    };
    const deltas = deltaMap[direction] || deltaMap.down;
    await scrollBy(
      tab.id,
      debuggerApi,
      point.x,
      point.y,
      deltas.deltaX,
      deltas.deltaY,
    );
    return { ok: true, action, point, ...deltas };
  }

  if (action === 'key') {
    const key = String(input.text || input.key || '').trim();
    if (!key) {
      throw new Error('text or key is required for key actions.');
    }
    await sendKeyEvent(tab.id, key, Number(input.modifiers) || 0);
    return { ok: true, action, key };
  }

  if (action === 'zoom') {
    const factor = Number(input.duration);
    if (!Number.isFinite(factor) || factor <= 0) {
      throw new Error('duration must be a zoom factor for zoom actions.');
    }
    await chrome.tabs.setZoom(tab.id, factor);
    return { ok: true, action, zoomFactor: factor };
  }

  if (action === 'type') {
    if (point) {
      await clickAt(tab.id, debuggerApi, point.x, point.y);
    }
    if (input.ref) {
      const ref = refStore.get(input.ref);
      if (!ref) throw new Error(`Unknown ref: ${input.ref}`);
      await focusSelector(tab.id, ref.selector);
    }
    const text = String(input.text || '');
    await typeText(tab.id, debuggerApi, text);
    return { ok: true, action, textLength: text.length, point: point || null };
  }

  return { error: `Unsupported computer action: ${action}` };
}

async function wait(input = {}) {
  const rawDuration = Number(input.duration);
  const duration = Number.isFinite(rawDuration) ? rawDuration : 1;
  const waitedMs = Math.min(
    30000,
    Math.max(0, duration < 100 ? duration * 1000 : duration),
  );

  await new Promise((resolve) => setTimeout(resolve, waitedMs));
  return { ok: true, waitedMs };
}

const toolImpl = {
  tabsContext,
  tabControl,
  javascriptTool,
  fileUpload,
  readPage,
  find: findElements,
  formInput,
  getPageText,
  navigate,
  readConsoleMessages,
  readNetworkRequests,
  resizeWindow,
  tabsCreate,
  turnAnswerStart: async () => ({ ok: true }),
  updatePlan: async (input = {}) => ({ ok: true, ...input }),
  computer,
  wait,
};

toolRegistry = createToolRegistry(toolImpl);

function toolDefinitionForOpenAI(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: JSON.parse(JSON.stringify(tool.input_schema)),
    },
  };
}

async function toOpenAIToolDefinitions() {
  const tools = toolRegistry.map(toolDefinitionForOpenAI);
  const tabControlTool = tools.find(
    (tool) => tool.function.name === 'tab_control',
  );

  if (tabControlTool) {
    const history = await getNavigationHistoryState();
    const actionSchema = tabControlTool.function.parameters?.properties?.action;
    if (actionSchema?.enum) {
      actionSchema.enum = actionSchema.enum.filter(
        (action) =>
          (action !== 'back' || history.canGoBack) &&
          (action !== 'forward' || history.canGoForward),
      );
    }
  }

  return tools;
}

async function toAnthropicToolDefinitions() {
  const tools = await toOpenAIToolDefinitions();
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

function normalizeGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;

  if (Array.isArray(schema)) {
    return schema.map(normalizeGeminiSchema);
  }

  const normalized = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type' && Array.isArray(value)) {
      normalized.type = value.includes('string') ? 'string' : value[0];
      continue;
    }

    if (key === 'properties' && value && typeof value === 'object') {
      normalized.properties = Object.fromEntries(
        Object.entries(value).map(([propertyName, propertySchema]) => [
          propertyName,
          normalizeGeminiSchema(propertySchema),
        ]),
      );
      continue;
    }

    if (key === 'items') {
      normalized.items = normalizeGeminiSchema(value);
      continue;
    }

    normalized[key] = normalizeGeminiSchema(value);
  }

  return normalized;
}

async function toGeminiToolDefinitions() {
  const tools = await toOpenAIToolDefinitions();
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: normalizeGeminiSchema(tool.function.parameters),
      })),
    },
  ];
}

function toOpenAIMessage(message) {
  if (message.role === 'assistant') {
    const serializedToolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls
          .map((call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: safeStringify(call.arguments || {}),
            },
          }))
          .filter((call) => call.id && call.function?.name)
      : [];

    return {
      role: 'assistant',
      content: message.content?.length ? message.content : null,
      tool_calls:
        serializedToolCalls.length > 0 ? serializedToolCalls : undefined,
    };
  }

  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.tool_call_id,
      name: message.name,
      content: message.content || '',
    };
  }

  return {
    role: 'user',
    content: message.content || '',
  };
}

function requestMessagesForConversation(conversation) {
  const conversationMessages = conversation.messages || [];
  const repairedMessages = [];
  const toolResponses = new Set(
    conversationMessages
      .filter((message) => message.role === 'tool' && message.tool_call_id)
      .map((message) => message.tool_call_id),
  );

  for (const message of conversationMessages) {
    repairedMessages.push(message);

    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) {
      continue;
    }

    for (const toolCall of message.tool_calls) {
      if (!toolCall.id || toolResponses.has(toolCall.id)) continue;
      const callName = toolCall.name || 'unknown tool';
      repairedMessages.push(
        createMessage('tool', `${callName} failed for missing tool response.`, {
          tool_call_id: toolCall.id,
          name: callName,
          isError: true,
        }),
      );
      toolResponses.add(toolCall.id);
    }
  }

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...repairedMessages.map(toOpenAIMessage),
  ];
}

function repairedConversationMessages(conversation) {
  return requestMessagesForConversation(conversation).filter(
    (message) => message.role !== 'system',
  );
}

function toAnthropicMessage(message) {
  if (message.role === 'assistant') {
    const content = [];
    if (message.content?.trim()) {
      content.push({ type: 'text', text: message.content });
    }

    for (const call of message.tool_calls || []) {
      if (!call.id || !call.function?.name) continue;
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: safeJsonParse(call.function.arguments || '{}') || {},
      });
    }

    return {
      role: 'assistant',
      content: content.length ? content : [{ type: 'text', text: '' }],
    };
  }

  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: message.tool_call_id,
          content: message.content || '',
        },
      ],
    };
  }

  return {
    role: 'user',
    content: message.content || '',
  };
}

function toGeminiContent(message) {
  if (message.role === 'assistant') {
    const parts = [];
    if (message.content?.trim()) {
      parts.push({ text: message.content });
    }

    for (const call of message.tool_calls || []) {
      if (!call.function?.name) continue;
      parts.push({
        functionCall: {
          name: call.function.name,
          args: safeJsonParse(call.function.arguments || '{}') || {},
        },
      });
    }

    return {
      role: 'model',
      parts: parts.length ? parts : [{ text: '' }],
    };
  }

  if (message.role === 'tool') {
    return {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: message.name,
            response: { result: message.content || '' },
          },
        },
      ],
    };
  }

  return {
    role: 'user',
    parts: [{ text: message.content || '' }],
  };
}

async function callOpenAICompatible(conversation, providerConfig) {
  const model = conversation.model || state.model || getDefaultModel();
  const body = {
    model,
    messages: requestMessagesForConversation(conversation),
    tools: await toOpenAIToolDefinitions(),
    tool_choice: 'auto',
  };

  if (!providerConfig.omitTemperature) {
    body.temperature = 0.2;
  }

  if (
    providerConfig === PROVIDERS.kimi &&
    (model === 'kimi-k2.6' || model === 'kimi-k2.5')
  ) {
    body.thinking = { type: 'disabled' };
  }

  const response = await fetch(providerConfig.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  if (!response.ok) {
    const message =
      data?.error?.message ||
      `${providerConfig.label} request failed with status ${response.status}`;
    throw new Error(message);
  }

  const choice = data?.choices?.[0]?.message;
  if (!choice) {
    throw new Error(`${providerConfig.label} returned no assistant message.`);
  }

  return choice;
}

async function callAnthropic(conversation, providerConfig) {
  const response = await fetch(providerConfig.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': state.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: conversation.model || state.model || getDefaultModel('anthropic'),
      system: SYSTEM_PROMPT,
      messages: repairedConversationMessages(conversation).map(toAnthropicMessage),
      tools: await toAnthropicToolDefinitions(),
      tool_choice: { type: 'auto' },
      max_tokens: 4096,
      temperature: 0.2,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    const message =
      data?.error?.message ||
      `${providerConfig.label} request failed with status ${response.status}`;
    throw new Error(message);
  }

  const content = Array.isArray(data.content) ? data.content : [];
  return {
    content: content
      .filter((part) => part.type === 'text')
      .map((part) => part.text || '')
      .join('\n'),
    tool_calls: content
      .filter((part) => part.type === 'tool_use')
      .map((part) => ({
        id: part.id,
        type: 'function',
        function: {
          name: part.name,
          arguments: safeStringify(part.input || {}),
        },
      })),
  };
}

async function callGemini(conversation, providerConfig) {
  const model = conversation.model || state.model || getDefaultModel('gemini');
  const url = `${providerConfig.endpoint}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(state.apiKey)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }],
      },
      contents: repairedConversationMessages(conversation).map(toGeminiContent),
      tools: await toGeminiToolDefinitions(),
      generationConfig: {
        temperature: 0.2,
      },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    const message =
      data?.error?.message ||
      `${providerConfig.label} request failed with status ${response.status}`;
    throw new Error(message);
  }

  const parts = data?.candidates?.[0]?.content?.parts || [];
  return {
    content: parts
      .filter((part) => typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n'),
    tool_calls: parts
      .filter((part) => part.functionCall?.name)
      .map((part) => ({
        id: uid('gemini_tool'),
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: safeStringify(part.functionCall.args || {}),
        },
      })),
  };
}

async function callProvider(conversation) {
  const providerId = getProviderId(conversation.provider || state.provider);
  const providerConfig = getProvider(providerId);

  if (providerConfig.adapter === 'anthropic') {
    return callAnthropic(conversation, providerConfig);
  }

  if (providerConfig.adapter === 'gemini') {
    return callGemini(conversation, providerConfig);
  }

  return callOpenAICompatible(conversation, providerConfig);
}

function normalizeAssistantMessage(choice) {
  return {
    id: uid('assistant'),
    role: 'assistant',
    content: choice.content || '',
    createdAt: Date.now(),
    tool_calls: Array.isArray(choice.tool_calls)
      ? choice.tool_calls.map((call) => ({
          id: call.id,
          name: call.function?.name,
          arguments: safeJsonParse(call.function?.arguments || '{}'),
        }))
      : [],
  };
}

async function executeToolCallAndRecord(conversationId, toolCall) {
  const conversation = getConversation(conversationId);
  if (!conversation) throw new Error('Conversation not found.');

  try {
    const context = toolRegistryContext(conversationId);
    const result = await executeToolCall(
      toolCall.name,
      toolCall.arguments || {},
      context,
      toolRegistry,
    );
    const content = normalizeToolResult(result);
    appendMessage(
      conversationId,
      createMessage('tool', content, {
        tool_call_id: toolCall.id,
        name: toolCall.name,
      }),
    );
    return content;
  } catch (error) {
    const callName = toolCall.name || 'unknown tool';
    const reason = error?.message || String(error);
    const content = `${callName} failed for ${reason}`;
    appendMessage(
      conversationId,
      createMessage('tool', content, {
        tool_call_id: toolCall.id,
        name: callName,
        isError: true,
      }),
    );
    throw error;
  }
}

function recordSkippedToolCall(conversationId, toolCall) {
  const callName = toolCall.name || 'unknown tool';
  appendMessage(
    conversationId,
    createMessage(
      'tool',
      `${callName} failed for skipped because an earlier tool call failed.`,
      {
        tool_call_id: toolCall.id,
        name: callName,
        isError: true,
      },
    ),
  );
}

function recordStoppedToolCalls(conversationId, toolCalls) {
  for (const toolCall of toolCalls) {
    const callName = toolCall.name || 'unknown tool';
    appendMessage(
      conversationId,
      createMessage('tool', `${callName} failed for stopped by user.`, {
        tool_call_id: toolCall.id,
        name: callName,
        isError: true,
      }),
    );
  }
}

async function runConversation(conversationId) {
  const conversation = getConversation(conversationId);
  if (!conversation) return;

  const providerLabel = getProvider(conversation.provider || state.provider).label;
  state.apiKey = state.apiKeys?.[conversation.provider || state.provider] || state.apiKey || '';

  if (!state.apiKey.trim()) {
    setStatus('Add an API key first');
    throw new Error(`Add your ${providerLabel} API key before sending a prompt.`);
  }

  setRunning(true);
  setStatus('Running');

  try {
    while (true) {
      if (state.stopRequested) {
        break;
      }

      const refreshedConversation = getConversation(conversationId);
      const choice = await callProvider(refreshedConversation);
      const assistantMessage = normalizeAssistantMessage(choice);
      appendMessage(conversationId, assistantMessage);

      if (!assistantMessage.tool_calls.length) {
        break;
      }

      if (state.stopRequested) {
        recordStoppedToolCalls(conversationId, assistantMessage.tool_calls);
        break;
      }

      for (
        let index = 0;
        index < assistantMessage.tool_calls.length;
        index += 1
      ) {
        const toolCall = assistantMessage.tool_calls[index];
        if (state.stopRequested) {
          recordStoppedToolCalls(
            conversationId,
            assistantMessage.tool_calls.slice(index),
          );
          break;
        }

        try {
          await executeToolCallAndRecord(conversationId, toolCall);
        } catch (error) {
          for (const skippedToolCall of assistantMessage.tool_calls.slice(
            index + 1,
          )) {
            recordSkippedToolCall(conversationId, skippedToolCall);
          }
          throw error;
        }
      }
    }

    setStatus('Idle');
  } catch (error) {
    appendMessage(
      conversationId,
      createMessage(
        'assistant',
        `Tooling or API error: ${error?.message || error}`,
      ),
    );
    setStatus('Error');
    throw error;
  } finally {
    setRunning(false);
    persistState();
    renderAll();
  }
}

function requestStopConversation() {
  if (!state.isRunning) return;
  state.stopRequested = true;
  setStatus('Stopping');
}

async function handleSubmit(event) {
  event.preventDefault();

  if (state.isRunning) return;

  const text = elements.promptInput.value.trim();
  if (!text) return;

  const conversation = getActiveConversation();
  updateConversationModel(conversation);
  appendMessage(conversation.id, createMessage('user', text));
  elements.promptInput.value = '';
  persistState();

  try {
    await runConversation(conversation.id);
  } catch {
    // The error is already surfaced in the transcript.
  }
}

function bindEvents() {
  elements.newConversationButton.addEventListener('click', newConversation);
  elements.conversationDrawerButton.addEventListener(
    'click',
    openConversationDrawer,
  );
  elements.drawerBackdrop.addEventListener('click', closeConversationDrawer);
  elements.settingsButton.addEventListener('click', showSettingsPage);
  elements.closeSettingsButton.addEventListener('click', showChatPage);
  elements.conversationSearchInput.addEventListener('input', () => {
    state.conversationSearch = elements.conversationSearchInput.value;
    renderConversationList();
  });
  elements.clearConversationsButton.addEventListener(
    'click',
    clearAllConversations,
  );

  elements.providerSelect.addEventListener('change', () => {
    setProvider(elements.providerSelect.value || DEFAULT_PROVIDER);
  });

  elements.apiKeyInput.addEventListener('input', () => {
    setCurrentApiKey(elements.apiKeyInput.value.trim());
    persistState();
  });

  elements.modelSelect.addEventListener('change', () => {
    if (elements.modelSelect.value === 'custom') {
      elements.customModelField.hidden = false;
      elements.customModelInput.value = getProviderModelOptions().includes(state.model)
        ? ''
        : state.model;
      elements.customModelInput.focus();
      return;
    }
    setModel(elements.modelSelect.value || getDefaultModel());
  });

  elements.customModelInput.addEventListener('input', () => {
    if (elements.modelSelect.value !== 'custom') return;
    setModel(elements.customModelInput.value || getDefaultModel());
  });

  elements.composer.addEventListener('submit', handleSubmit);
  elements.sendButton.addEventListener('click', (event) => {
    if (!state.isRunning) return;
    event.preventDefault();
    requestStopConversation();
  });

  elements.promptInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      elements.composer.requestSubmit();
    }
  });

  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    loadState();
    renderAll();
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.isDrawerOpen) {
      closeConversationDrawer();
    }
  });

  compactLayoutQuery.addEventListener('change', renderDrawer);
}

function normalizeConversationModels() {
  for (const conversation of state.conversations) {
    conversation.provider = getProviderId(conversation.provider || state.provider);
    if (!conversation.model) {
      conversation.model = state.model || getDefaultModel(conversation.provider);
    }
  }
}

function initialize() {
  loadState();
  normalizeConversationModels();
  toolRegistry = createToolRegistry(toolImpl);
  bindEvents();
  renderAll();
  setStatus('Idle');

  renderModelControls();
}

initialize();
