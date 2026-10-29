import { describe, expect, it } from 'vitest';
import { emailActionCode } from '@/features/cloud/emailLink';

const domain = 'lunatoc-demo.firebaseapp.com';
const apiKey = 'AIzaSy-Test-api-key-public';
const valid = 'https://' + domain + '/__/auth/action?mode=signIn&oobCode=singleUseEmailCode1234567890&apiKey=' + apiKey;

describe('Firebase email link parser', () => {
  it('extracts a code only from the maintainer authorized HTTPS domain', () => {
    expect(emailActionCode(valid, domain, apiKey)).toBe('singleUseEmailCode1234567890');
  });
  it('allows a nested Firebase Hosting link only when both hosts are trusted', () => {
    const outer = 'https://' + domain + '/?link=' + encodeURIComponent(valid);
    expect(emailActionCode(outer, domain, apiKey)).toBe('singleUseEmailCode1234567890');
  });
  it.each([
    'https://attacker.firebaseapp.com/__/auth/action?mode=signIn&oobCode=singleUseEmailCode1234567890&apiKey='+apiKey,
    valid.replace('apiKey='+apiKey, 'apiKey=other-project'),
    valid.replace('mode=signIn','mode=verifyEmail'),
    valid.replace('oobCode=singleUseEmailCode1234567890','oobCode=abc'),
    'http://'+valid.slice(8),
    'not-a-url',
    'https://'+domain+'/?link='+encodeURIComponent('https://evil.example.com/?mode=signIn&oobCode=singleUseEmailCode1234567890&apiKey='+apiKey),
  ])('rejects invalid, cross-project or phished email sign-in URL (%s)', (link) => {
    expect(() => emailActionCode(link, domain, apiKey)).toThrow();
  });
});
