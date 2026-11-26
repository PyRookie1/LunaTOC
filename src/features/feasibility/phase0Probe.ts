/** One-shot, read-only check. The report never contains conversation text. */
import { getCurrentRouteKey } from '@/platforms/chatgpt/routing';
import { subscribeTrustedPageHookMessage } from '@/navigation/pageHookMessageTransport';
import { TOC_REFRESH_CANCEL, TOC_REFRESH_REQUEST, TOC_REFRESH_RESULT, TOC_REFRESH_TIMEOUT_MS } from '@/navigation/refresh/refreshProtocol';
import type { ConversationSnapshot } from '@/navigation/state/activeBranch';

let running = false;
let requestIdCounter = 1_000_000_000;

function readCompleteBranch(routeKey: string): Promise<ConversationSnapshot | null> {
  const requestId = requestIdCounter++;
  return new Promise((resolve) => {
    let done = false;
    const finish = (payload: ConversationSnapshot | null): void => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      unsubscribe();
      resolve(payload);
    };
    const unsubscribe = subscribeTrustedPageHookMessage((event) => {
      const result = event.data as { type?: string; routeKey?: string; requestId?: number; payload?: ConversationSnapshot | null } | null;
      if (result?.type === TOC_REFRESH_RESULT && result.routeKey === routeKey && result.requestId === requestId) {
        finish(result.payload ?? null);
      }
    });
    const timer = window.setTimeout(() => {
      window.postMessage({ type: TOC_REFRESH_CANCEL, routeKey, requestId }, location.origin);
      finish(null);
    }, TOC_REFRESH_TIMEOUT_MS + 1_000);
    window.postMessage({ type: TOC_REFRESH_REQUEST, routeKey, requestId }, location.origin);
  });
}

async function checkVisibleImage(root: Element | null): Promise<string> {
  const image = root?.querySelector<HTMLImageElement>('img');
  if (!image) return '当前显示区域没有图片，尚未验证图片读取。';
  const source = image.currentSrc || image.src;
  if (!source) return '图片尚未加载。';
  let url: URL;
  try { url = new URL(source, location.href); } catch { return '图片地址无法识别。'; }
  if (!['https:', 'http:', 'blob:', 'data:'].includes(url.protocol)) return '图片来源不受支持。';
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(source, { credentials: 'include', signal: controller.signal });
    if (!response.ok) return '当前图片未能读取。';
    const blob = await response.blob();
    return blob.type.startsWith('image/') && blob.size > 0
      ? `当前图片可读取，大小 ${blob.size} 字节。`
      : '当前图片返回的内容不是可识别的图片。';
  } catch { return '当前图片未能读取，需检查图片来源及扩展权限。'; }
  finally { window.clearTimeout(timeout); }
}

export async function collectPhase0Report(): Promise<string> {
  const routeKey = getCurrentRouteKey();
  const root = document.querySelector('.thread-scroll-container');
  const snapshot = /^[A-Za-z0-9_-]{8,128}$/.test(routeKey) ? await readCompleteBranch(routeKey) : null;
  const messages = getCurrentRouteKey() === routeKey && snapshot?.activeBranchVerified === true &&
    snapshot.page_info?.has_previous_page === false ? snapshot.messages : null;
  const images = messages?.reduce((count, message) => count + (message.content?.parts ?? [])
    .filter((part) => typeof part !== 'string' && part.content_type === 'image_asset_pointer').length, 0) ?? 0;
  const attachments = messages?.reduce((count, message) => count + (message.metadata?.attachments?.length ?? 0), 0) ?? 0;
  const mountedIds = new Set(Array.from(root?.querySelectorAll('[data-message-id]') ?? [])
    .map((element) => element.getAttribute('data-message-id')).filter(Boolean));
  const imageCheck = await checkVisibleImage(root);
  return [
    'LunaTOC 对话导出可行性检查',
    `检查时间：${new Date().toLocaleString('zh-CN')}`,
    `扩展版本：${chrome.runtime.getManifest().version}`,
    `当前对话完整读取：${messages ? '通过' : '未通过或无法证明完整'}`,
    `已核对的有效分支消息：${messages?.length ?? 0} 条`,
    `其中用户消息：${messages?.filter((item) => item.author?.role === 'user').length ?? 0} 条`,
    `识别的图片内容：${images} 处；附件：${attachments} 个`,
    `当前页面已挂载的消息身份：${mountedIds.size} 个；图片：${root?.querySelectorAll('img').length ?? 0} 张`,
    `当前页面的消息复制控件：${root?.querySelectorAll('button[aria-label*="Copy"],button[aria-label*="复制"]').length ?? 0} 个`,
    `当前页面的展开控件：${root?.querySelectorAll('[aria-expanded="false"]').length ?? 0} 个`,
    `图片读取：${imageCheck}`,
    '点击瞬间内容冻结：尚未验证。',
    '文档格式与下载完成：尚未验证。',
    '报告不含正文、图片数据、对话地址及账号标识。',
  ].join('\n') + '\n';
}

export function installPhase0Probe(sidebar: HTMLElement): void {
  const button = sidebar.querySelector<HTMLButtonElement>('#luna-toc-phase0-probe');
  if (!button) return;
  button.addEventListener('click', async () => {
    if (running) return;
    running = true;
    button.disabled = true;
    const label = button.getAttribute('aria-label') || '检查当前对话兼容性';
    const setLabel = (value: string): void => {
      button.setAttribute('aria-label', value);
      button.title = value;
    };
    setLabel('正在检查当前对话');
    try {
      const report = await collectPhase0Report();
      const url = URL.createObjectURL(new Blob([report], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `LunaTOC-兼容性检查-${Date.now()}.txt`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setLabel('检查报告已生成，请查看浏览器下载记录');
    } catch { setLabel('检查失败，请重试'); }
    finally {
      running = false;
      window.setTimeout(() => { setLabel(label); button.disabled = false; }, 2_000);
    }
  });
}
