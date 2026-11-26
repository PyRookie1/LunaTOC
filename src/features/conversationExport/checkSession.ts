import { captureConversationOwner, isConversationOwnerCurrent, subscribeActiveConversationOwner } from '@/navigation/lifecycle/conversationOwner';
import { revalidateConversationOwnerForExtension } from '@/navigation/lifecycle/conversationLifecycle';
import { getCurrentRouteKey } from '@/platforms/chatgpt/routing';
import { CHATGPT_MESSAGE_TYPES } from '@/platforms/chatgpt/messages';
import { subscribeTrustedPageHookMessage } from '@/navigation/pageHookMessageTransport';
import { TOC_EDIT_SUBMISSION } from '@/navigation/refresh/refreshProtocol';
import { TOC_TRUSTED_CONVERSATION_DELETED } from '@/navigation/lifecycle/protocol';
import { CaptureTask } from './task';
import { readCaptureSnapshot } from './readSnapshot';
import { extractBranch, hasUnfinishedMessage } from './extraction';
import { checkFixedRange, type BranchCapture } from './model';
import { generationState, observedClickAnchor } from './runtime';
import { TaskImageReader, visibleImage } from './images';
import { inspectRenderedEvidence, type RenderedEvidence } from './renderedEvidence';

export type CheckScenario = 'stable' | 'append' | 'edit' | 'branch' | 'route';
export const SCENARIO_LABELS: Record<CheckScenario, string> = {
  stable: '保持对话不变', append: '新增消息', edit: '修改历史提问', branch: '重新生成或切换回答版本', route: '切换其他对话',
};
export type CheckPhase = 'reading' | 'waiting' | 'checking' | 'done';

/** Ephemeral, read-only capture exercise. Its report is a whitelist of aggregates. */
export class CaptureCheckSession {
  readonly task = new CaptureTask();
  phase: CheckPhase = 'reading';
  status = '正在读取并核对当前对话…';
  private baseline: BranchCapture | null = null;
  private readonly route = getCurrentRouteKey();
  private readonly owner = captureConversationOwner();
  private readonly anchor = observedClickAnchor(this.route);
  private readonly started = performance.now();
  private startedOnce = false;
  private finishing = false;
  private reportText = '';
  private imageText = '未验证：当前视口没有可读取的已加载图片。';
  private counts = { nodes: 0, users: 0, text: 0, images: 0, attachments: 0, unknown: 0, blocks: 0 };
  private sourceText = '未验证';
  private generationText = '状态未知，不能据此允许正式导出';
  private rangeText = '未验证';
  private reason = '';
  private scopeAtClick = false;
  private additions = false;
  private userCancelled = false;
  private rendered: RenderedEvidence = { matched: 0, mounted: 0, code: 0, headings: 0, images: 0 };

  constructor(readonly scenario: CheckScenario, private readonly notify: () => void = () => {}) {
    this.task.addCleanup(subscribeActiveConversationOwner(() => {
      if (!isConversationOwnerCurrent(this.owner)) this.stop(getCurrentRouteKey() !== this.route
        ? '已检测到对话切换，检查已停止。' : '账号状态已变化，检查已停止。');
    }));
    this.task.addCleanup(subscribeTrustedPageHookMessage(event => {
      const data = event.data;
      if (data?.type === CHATGPT_MESSAGE_TYPES.routeChanged && getCurrentRouteKey() !== this.route) {
        this.stop('已检测到对话切换，检查已停止。');
      }
      if (data?.routeKey !== this.route || !this.baseline) return;
      if (data.type === TOC_EDIT_SUBMISSION && data.stage === 'accepted' &&
          this.baseline.messages.some(message => message.id === data.messageId ||
            message.id === data.parentMessageId && message.id !== this.baseline!.messages.at(-1)?.id)) {
        this.stop('已检测到历史内容或回答路径变化，检查已停止。');
      }
      if (data.type === CHATGPT_MESSAGE_TYPES.conversationData &&
          data.payload?.page_info?.has_previous_page === false) {
        try {
          const result = checkFixedRange(this.baseline, extractBranch(data.payload));
          if (result === 'changed') this.stop('已检测到历史内容或回答路径变化，检查已停止。');
          if (result === 'appended') this.additions = true;
        } catch { /* An unverified host response is not replacement authority. */ }
      }
    }));
    const onPageHide = (): void => this.stop('页面已离开，检查已停止。');
    const onRoute = (): void => { if (getCurrentRouteKey() !== this.route) this.stop('已检测到对话切换，检查已停止。'); };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('popstate', onRoute);
    this.task.addCleanup(() => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('popstate', onRoute);
    });
    const onRuntimeMessage = (message: { type?: string; routeKey?: string }, sender: chrome.runtime.MessageSender): void => {
      if (sender.id === chrome.runtime.id && message?.type === TOC_TRUSTED_CONVERSATION_DELETED &&
          message.routeKey === this.route) this.stop('当前对话已删除，检查已停止。');
    };
    chrome.runtime.onMessage?.addListener(onRuntimeMessage);
    this.task.addCleanup(() => chrome.runtime.onMessage?.removeListener(onRuntimeMessage));
    this.task.signal.addEventListener('abort', () => {
      if (this.phase !== 'done') {
        this.reason ||= this.task.signal.reason === 'timeout' ? '检查已超时，临时数据已释放。' : '检查已停止。';
        this.complete();
      }
    }, { once: true });
  }

  private assertCurrent(): void {
    this.task.check();
    if (getCurrentRouteKey() !== this.route || !isConversationOwnerCurrent(this.owner)) {
      this.stop('账号或对话状态已变化，检查已停止。');
      this.task.check();
    }
  }

  async begin(interactive = true): Promise<void> {
    if (this.startedOnce) return;
    this.startedOnce = true;
    try {
      this.assertCurrent();
      const owner = await revalidateConversationOwnerForExtension();
      this.assertCurrent();
      if (!owner) throw new Error('identity');
      if (generationState(this.route) !== 'unknown' && generationState(this.route) !== 'ready') {
        this.stop('当前回答仍在生成或等待稳定，请结束后重新检查。'); return;
      }
      const snapshot = await readCaptureSnapshot(this.route, this.task.signal);
      this.assertCurrent();
      if (hasUnfinishedMessage(snapshot)) {
        this.stop('当前回答仍在生成，请结束后重新检查。'); return;
      }
      this.generationText = generationState(this.route, document, snapshot) === 'ready'
        ? '已读取到回答结束标记；仍需独立核对媒体和内容版本' : '状态未知；本次只读检查不代表允许正式导出';
      const capture = extractBranch(snapshot);
      if (capture.messages.length === 0) throw new Error('empty');
      if (this.anchor) {
        const index = capture.messages.findIndex(message => message.id === this.anchor);
        if (index < 0) { this.stop('点击前观察到的末消息已不在当前路径中，检查已停止。'); return; }
        this.additions = index + 1 < capture.messages.length;
        capture.messages = capture.messages.slice(0, index + 1);
        this.scopeAtClick = true;
      }
      this.baseline = capture;
      this.rendered = inspectRenderedEvidence(capture, document.querySelector('.thread-scroll-container'));
      this.sourceText = capture.source === 'tree' ? '会话树，单次读取' : capture.source === 'pages'
        ? `分页读取，共 ${capture.pages} 页；分页间原子一致性尚未证明` : '来源未确认';
      this.counts.nodes = capture.messages.length;
      for (const message of capture.messages.filter(item => item.visible)) {
        if (message.role === 'user') this.counts.users++;
        this.counts.attachments += message.attachments.length;
        this.counts.unknown += message.unsupportedParts;
        for (const part of message.parts) {
          if (part.kind === 'image') this.counts.images++;
          if (part.kind === 'text') { this.counts.text += part.text.length; this.counts.blocks += part.blocks.length; }
        }
      }
      const image = visibleImage(document.querySelector('.thread-scroll-container'));
      if (image) {
        const imageController = new AbortController();
        const abort = (): void => imageController.abort();
        this.task.signal.addEventListener('abort', abort, { once: true });
        const timeout = setTimeout(abort, 5_000);
        try {
          const result = await new TaskImageReader(imageController.signal).read(image.currentSrc || image.src);
          this.assertCurrent();
          this.imageText = `已通过：一张当前视口图片可读取并解码，${result.bytes} 字节，${result.width} × ${result.height}；原图及其他图片未验证。`;
        } catch {
          this.assertCurrent();
          this.imageText = '未通过：当前视口图片未能读取或解码，其他图片仍未验证。';
        } finally {
          clearTimeout(timeout);
          this.task.signal.removeEventListener('abort', abort);
          imageController.abort();
        }
      }
      this.assertCurrent();
      if (interactive) {
        this.phase = 'waiting';
        this.status = '范围已固定。请执行所选页面操作，再点击“完成检查”。三分钟后自动停止。';
        this.notify();
      } else await this.finish();
    } catch {
      if (this.phase !== 'done') this.stop('未能完成当前对话的只读检查，请等待页面稳定后重试。');
    }
  }

  async finish(): Promise<void> {
    if (!this.baseline || this.finishing || this.phase === 'done') return;
    this.finishing = true;
    this.phase = 'checking'; this.status = '正在重新读取固定范围并核对变化…'; this.notify();
    try {
      this.assertCurrent();
      const snapshot = await readCaptureSnapshot(this.route, this.task.signal);
      this.assertCurrent();
      const next = extractBranch(snapshot);
      const result = checkFixedRange(this.baseline, next);
      if (result === 'changed') { this.stop('已检测到历史内容或回答路径变化，检查已停止。'); return; }
      this.additions ||= result === 'appended';
      const owner = await revalidateConversationOwnerForExtension();
      this.assertCurrent();
      if (!owner) throw new Error('identity');
      this.rangeText = this.scopeAtClick ? '已通过：点击前已观察到的消息范围保持一致' :
        '部分验证：首次完整读取的范围保持一致；点击时范围尚未确认';
      this.complete();
    } catch {
      if (!this.task.signal.aborted) this.stop('未能完成第二次读取，固定范围一致性未通过。');
    }
  }

  cancel(): void { this.userCancelled = true; this.stop('用户已停止检查，临时数据已释放。'); }
  dispose(): void { this.task.cancel('disposed'); this.baseline = null; }
  report(): string { return this.reportText; }

  private stop(reason: string): void {
    if (this.phase === 'done') return;
    this.reason = reason;
    this.task.cancel('stopped');
  }

  private complete(): void {
    if (this.phase === 'done') return;
    this.phase = 'done';
    const expectedChange = this.scenario === 'route' ? this.reason.includes('对话切换') : this.reason.includes('历史内容');
    const scenarioResult = this.userCancelled ? '未验证：用户停止了本次检查' : this.scenario === 'stable'
      ? this.reason ? '未通过：检查未完成' : '已完成两次读取核对；不代表原子快照通过'
      : this.scenario === 'append' ? this.additions && !this.reason ? '已通过：检测到新增消息且固定范围未改变'
        : '未验证：未完成新增消息的排除核对'
      : expectedChange ? '已通过：检测到变化并停止检查' : '未验证：未检测到预期变化，不能据此判定通过';
    this.status = this.reason || '检查已完成，可导出本地报告。';
    this.reportText = [
      'LunaTOC 阶段一功能与时间边界检查',
      `检查时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）`,
      `扩展版本：${chrome.runtime.getManifest().version}`,
      `测试构建：${__LUNATOC_BUILD_ID__}`,
      `测试场景：${SCENARIO_LABELS[this.scenario]}`,
      `结果：${this.status}`,
      `场景核对：${scenarioResult}`,
      `消息路径与分页：${this.counts.nodes ? '已读取到终止分页和有效路径；正文完整性另行判断' : '未验证'}`,
      `读取来源：${this.sourceText}`,
      `固定范围：${this.reason ? '检查已中止，不能作为导出依据' : this.rangeText}`,
      `范围内节点：${this.counts.nodes} 个；用户消息：${this.counts.users} 条`,
      `保留的原始文字：${this.counts.text} 字符；基础格式块：${this.counts.blocks} 个`,
      `当前页面格式映射：${this.rendered.matched} 条消息；代码块 ${this.rendered.code} 个；标题 ${this.rendered.headings} 个；图片 ${this.rendered.images} 张。未挂载或无法匹配的内容未验证。`,
      `未支持的可见内容：${this.counts.unknown} 处；正文保真：${this.counts.unknown ? '存在未支持内容' : '已保留读取来源中的文字；与服务器完整原文一致仍未验证'}`,
      `图片引用：${this.counts.images} 处；附件：${this.counts.attachments} 个`,
      `图片读取：${this.imageText}`,
      `生成状态：${this.generationText}`,
      `开始后新增内容：${this.additions ? '已检测到；不纳入固定范围' : '未检测到；不等于证明没有新增'}`,
      '点击瞬间内容冻结：尚未验证。当前来源没有可绑定点击时刻的共同快照证明。',
      '分页内容版本一致性：两次读取核对不能替代共同版本证明；修改后恢复等未观察到的变化仍无法排除。',
      '正式导出许可：未通过。本阶段不生成 DOCX，不启用持续记录。',
      `任务耗时：${Math.round(performance.now() - this.started)} 毫秒`,
      '临时数据：已释放消息内容、任务监听和请求；仅保留本报告统计。',
      '报告不含正文、图片数据、附件名称、对话地址、消息身份、账号标识和访问凭据。',
    ].join('\n') + '\n';
    this.baseline = null;
    this.task.cancel('completed');
    this.notify();
  }
}
