const PANEL_PATH = 'sidepanel.html';
const openPanelWindows = new Set();

async function openSidePanel(windowId) {
  if (typeof windowId !== 'number') return;
  await chrome.sidePanel.open({ windowId });
  openPanelWindows.add(windowId);
}

async function closeSidePanel(windowId) {
  if (typeof windowId !== 'number') return;
  if (!chrome.sidePanel.close) return;
  await chrome.sidePanel.close({ windowId });
  openPanelWindows.delete(windowId);
}

async function toggleSidePanel(windowId) {
  if (typeof windowId !== 'number') return;

  if (openPanelWindows.has(windowId) && chrome.sidePanel.close) {
    await closeSidePanel(windowId);
    return;
  }

  await openSidePanel(windowId);
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.windowId !== undefined) {
    await toggleSidePanel(tab.windowId);
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-side-panel') return;

  if (tab?.windowId !== undefined) {
    await toggleSidePanel(tab.windowId).catch(() => {});
  }
});

if (chrome.sidePanel.onOpened) {
  chrome.sidePanel.onOpened.addListener((info) => {
    if (typeof info.windowId === 'number') {
      openPanelWindows.add(info.windowId);
    }
  });
}

if (chrome.sidePanel.onClosed) {
  chrome.sidePanel.onClosed.addListener((info) => {
    if (typeof info.windowId === 'number') {
      openPanelWindows.delete(info.windowId);
    }
  });
}
