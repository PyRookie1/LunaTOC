/** Phase zero entry backed by the phase one read-only pipeline. */
import { CaptureCheckSession, SCENARIO_LABELS, type CheckScenario } from '@/features/conversationExport/checkSession';
import { holdSidebarOpen, setSidebarHidden } from '@/features/sidebarVisibility';
import { OPEN_CAPTURE_CHECK } from '@/navigation/refresh/refreshProtocol';

export async function collectPhase0Report(): Promise<string> {
  const session = new CaptureCheckSession('stable');
  await session.begin(false);
  const report = session.report();
  session.dispose();
  return report;
}

export function installPhase0Probe(sidebar: HTMLElement): void {
  const entry = sidebar.querySelector<HTMLButtonElement>('#luna-toc-phase0-probe');
  if (!entry) return;
  entry.title = '对话功能与时间边界检查';
  entry.setAttribute('aria-label', entry.title);
  const panel = document.createElement('section');
  panel.id = 'luna-capture-check-panel';
  panel.className = 'luna-capture-check-panel';
  panel.setAttribute('aria-label', '对话功能检查');
  panel.hidden = true;
  const title = document.createElement('strong'); title.textContent = '对话功能与时间边界检查';
  const heading = document.createElement('div'); heading.className = 'luna-capture-check-heading';
  const body = document.createElement('div'); body.className = 'luna-capture-check-body';
  const description = document.createElement('p');
  description.textContent = '检查仅在本地运行，不保存正文。快速检查核对两次读取；时间边界检查等待你执行页面操作。';
  const select = document.createElement('select'); select.id = 'luna-capture-scenario';
  select.setAttribute('aria-label', '选择检查场景');
  for (const [value, label] of Object.entries(SCENARIO_LABELS)) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option);
  }
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.id = 'luna-capture-check-status';
  status.textContent = '请等待回答结束后开始。点击瞬间的内容冻结仍需独立版本证明。';
  const actions = document.createElement('div'); actions.className = 'luna-capture-check-actions';
  const button = (id: string, label: string): HTMLButtonElement => {
    const item = document.createElement('button'); item.type = 'button'; item.id = id; item.textContent = label;
    actions.append(item); return item;
  };
  const quick = button('luna-capture-quick', '快速检查');
  const start = button('luna-capture-start', '开始边界检查');
  const finish = button('luna-capture-finish', '完成检查');
  const cancel = button('luna-capture-cancel', '停止检查');
  const download = button('luna-capture-download', '导出检查报告');
  const restart = button('luna-capture-restart', '重新检查');
  const close = document.createElement('button');
  close.type = 'button'; close.id = 'luna-capture-close'; close.textContent = '×';
  close.setAttribute('aria-label', '关闭检查'); close.title = '关闭检查';
  heading.append(title, close);
  body.append(select, description, status);
  panel.append(heading, body, actions);
  sidebar.append(panel);
  let session: CaptureCheckSession | null = null;
  let releaseHold: (() => void) | null = null;
  const objectUrls = new Map<string, ReturnType<typeof setTimeout>>();
  const releaseUrls = (): void => {
    for (const [url, timer] of objectUrls) { clearTimeout(timer); URL.revokeObjectURL(url); }
    objectUrls.clear();
  };
  const render = (): void => {
    const active = session !== null && session.phase !== 'done';
    const idle = session === null;
    quick.hidden = start.hidden = !idle;
    finish.hidden = cancel.hidden = !active;
    download.hidden = restart.hidden = idle || active;
    quick.disabled = start.disabled = select.disabled = active;
    finish.disabled = session?.phase !== 'waiting';
    cancel.disabled = !active;
    download.disabled = session?.phase !== 'done';
    if (session) status.textContent = session.status;
    else status.textContent = '请等待回答结束后开始。点击瞬间的内容冻结仍需独立版本证明。';
  };
  const open = (): void => {
    panel.hidden = false; setSidebarHidden(false);
    releaseHold ??= holdSidebarOpen();
    render();
  };
  entry.addEventListener('click', open);
  const run = (interactive: boolean): void => {
    if (session && session.phase !== 'done') return;
    session?.dispose();
    session = new CaptureCheckSession(interactive ? select.value as CheckScenario : 'stable', render);
    render();
    void session.begin(interactive);
  };
  quick.addEventListener('click', () => run(false));
  start.addEventListener('click', () => run(true));
  finish.addEventListener('click', () => { void session?.finish(); });
  cancel.addEventListener('click', () => session?.cancel());
  restart.addEventListener('click', () => {
    if (session?.phase !== 'done') return;
    session.dispose(); session = null; body.scrollTop = 0; render();
  });
  close.addEventListener('click', () => {
    session?.dispose(); session = null; panel.hidden = true;
    releaseHold?.(); releaseHold = null; releaseUrls();
  });
  download.addEventListener('click', () => {
    const report = session?.report();
    if (!report) return;
    const url = URL.createObjectURL(new Blob([report], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = `LunaTOC-阶段一检查-${Date.now()}.txt`;
    document.body.append(link); link.click(); link.remove();
    const timer = setTimeout(() => { URL.revokeObjectURL(url); objectUrls.delete(url); }, 30_000);
    objectUrls.set(url, timer);
  });
  const handleRuntime = (message: { type?: string }, sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void): boolean | void => {
    if (message?.type !== OPEN_CAPTURE_CHECK || sender.id !== chrome.runtime.id) return;
    open(); sendResponse({ ok: true }); return false;
  };
  chrome.runtime.onMessage.addListener(handleRuntime);
  window.addEventListener('pagehide', () => {
    session?.dispose(); releaseHold?.(); releaseHold = null; releaseUrls();
  });
  render();
}
