/** Validate a Firebase one-time email sign-in link before exchanging its code.
 * Never follow user-supplied URLs or place them in logs.
 */
export function emailActionCode(link: unknown, authDomain: string, apiKey: string): string {
  if (typeof link !== 'string' || link.length < 30 || link.length > 12000) {
    throw new Error('请粘贴验证邮件中的完整 HTTPS 链接');
  }
  let current = link.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    let url: URL;
    try { url = new URL(current); }
    catch { throw new Error('验证链接格式无效'); }
    if (url.protocol !== 'https:' || url.hostname !== authDomain ||
        url.username || url.password || url.port) {
      throw new Error('验证链接域名与 LunaTOC 官方 Firebase 项目不匹配');
    }
    const mode = url.searchParams.get('mode');
    const oobCode = url.searchParams.get('oobCode');
    const key = url.searchParams.get('apiKey');
    if (mode !== null || oobCode !== null || key !== null) {
      if (mode !== 'signIn' || key !== apiKey ||
          !oobCode || !/^[A-Za-z0-9_-]{10,4096}$/.test(oobCode)) {
        throw new Error('这不是当前 LunaTOC Firebase 项目的有效邮件登录链接');
      }
      return oobCode;
    }
    const next = url.searchParams.get('link') ?? url.searchParams.get('deep_link_id');
    if (!next || next === current) throw new Error('验证链接中没有邮件登录验证码');
    current = next;
  }
  throw new Error('邮件登录链接嵌套过深');
}
