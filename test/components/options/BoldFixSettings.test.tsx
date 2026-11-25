/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoldFixSettings } from '@/components/options/BoldFixSettings';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  subscribe: vi.fn(),
}));
const analysisMocks = vi.hoisted(() => ({
  read: vi.fn(), write: vi.fn(), subscribe: vi.fn(),
}));
vi.mock('@/features/analysisVisibility/analysisVisibilitySettings', () => ({
  DEFAULT_ANALYSIS_HIDE_ENABLED: true,
  readAnalysisHideEnabled: analysisMocks.read,
  writeAnalysisHideEnabled: analysisMocks.write,
  subscribeAnalysisHideEnabled: analysisMocks.subscribe,
}));
vi.mock('@/features/boldFix/boldFixSettings', () => ({
  DEFAULT_BOLD_FIX_ENABLED: true,
  readBoldFixEnabled: mocks.read,
  writeBoldFixEnabled: mocks.write,
  subscribeBoldFixEnabled: mocks.subscribe,
}));

let host: HTMLDivElement;
let root: Root;
const externalEvents: { listener?: (enabled: boolean) => void } = {};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  delete externalEvents.listener;
  mocks.read.mockReset().mockResolvedValue(true);
  mocks.write.mockReset().mockResolvedValue(undefined);
  mocks.subscribe.mockReset().mockImplementation((listener: (enabled: boolean) => void) => {
    externalEvents.listener = listener;
    return () => { delete externalEvents.listener; };
  });
  analysisMocks.read.mockReset().mockResolvedValue(true);
  analysisMocks.write.mockReset().mockResolvedValue(undefined);
  analysisMocks.subscribe.mockReset().mockReturnValue(() => {});
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(<BoldFixSettings />);
    await Promise.resolve();
  });
}

function toggle(): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>('#bold-fix-toggle');
  if (!input) throw new Error('Missing bold-fix toggle');
  return input;
}

describe('BoldFixSettings', () => {
  it('shows the extra-features section and defaults to enabled', async () => {
    await render();
    expect(host.querySelector('#extra-features-heading')?.textContent).toBe('额外功能');
    expect(host.textContent).toContain('粗体异常修复');
    expect(toggle().checked).toBe(true);
    expect(toggle().disabled).toBe(false);
    expect((host.querySelector('#analysis-hide-toggle') as HTMLInputElement).checked).toBe(true);
  });

  it('saves the analysis visibility choice and reports a failed write', async () => {
    await render();
    const input = host.querySelector('#analysis-hide-toggle') as HTMLInputElement;
    await act(async () => { input.click(); await Promise.resolve(); });
    expect(analysisMocks.write).toHaveBeenCalledWith(false);
    expect(input.checked).toBe(false);
    analysisMocks.write.mockRejectedValueOnce(new Error('storage unavailable'));
    await act(async () => { input.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(input.checked).toBe(true);
    expect(host.textContent).toContain('隐藏分析区块设置保存失败');
  });

  it('loads a previously saved disabled state', async () => {
    mocks.read.mockResolvedValueOnce(false);
    await render();
    expect(toggle().checked).toBe(false);
  });

  it('persists a user toggle and follows changes from another extension context', async () => {
    await render();
    await act(async () => {
      toggle().click();
      await Promise.resolve();
    });
    expect(mocks.write).toHaveBeenCalledWith(false);
    expect(toggle().checked).toBe(false);

    await act(async () => externalEvents.listener?.(true));
    expect(toggle().checked).toBe(true);
  });

  it('restores the saved state and reports an error when persistence fails', async () => {
    mocks.read.mockResolvedValue(true);
    mocks.write.mockRejectedValueOnce(new Error('storage unavailable'));
    await render();

    await act(async () => {
      toggle().click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toggle().checked).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent)
      .toContain('粗体异常修复设置保存失败');
  });

  it('disables the switch while a write is pending', async () => {
    let finishWrite!: () => void;
    mocks.write.mockReturnValueOnce(new Promise<void>((resolve) => { finishWrite = resolve; }));
    await render();

    await act(async () => toggle().click());
    expect(toggle().disabled).toBe(true);

    await act(async () => { finishWrite(); });
    expect(toggle().disabled).toBe(false);
  });
});
