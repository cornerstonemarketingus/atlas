const KEY = 'atlas.device.credential';
const SAFE_ERROR = 'Atlas could not connect. Check your connection and try again.';
export function trustedOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter an HTTPS origin without a path.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Enter an HTTPS origin without a path.');
  return url.origin;
}
export function createDeviceClient({ http, vault, timeoutMs = 12000 }) {
  let record = null;
  let generation = 0;
  let busy = false;
  async function request(origin, path, { token, data } = {}) {
    let timer;
    try {
      const response = await Promise.race([
        http.request({ url: origin + path, method: data ? 'POST' : 'GET', data,
          headers: { Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          disableRedirects: true, connectTimeout: timeoutMs, readTimeout: timeoutMs }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(SAFE_ERROR)), timeoutMs); }),
      ]);
      if (!response.url || new URL(response.url).href !== origin + path || response.status < 200 || response.status >= 300) throw new Error(SAFE_ERROR);
      return typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    } catch { throw new Error(SAFE_ERROR); }
    finally { clearTimeout(timer); }
  }
  return {
    async restore() {
      const version = generation;
      const stored = await vault.get({ key: KEY }).catch(() => null);
      if (!stored?.value) return false;
      try {
        const parsed = JSON.parse(stored.value);
        if (parsed.version !== 1 || trustedOrigin(parsed.origin) !== parsed.origin || typeof parsed.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(parsed.token)) throw new Error();
        if (version !== generation) return false;
        record = parsed;
        return true;
      } catch { throw new Error('Pair this device again from your Atlas owner device.'); }
    },
    async pair({ origin, code }) {
      if (busy || record) throw new Error('Disconnect before pairing again.');
      origin = trustedOrigin(origin);
      if (!/^\d{6}$/.test(code)) throw new Error('Enter the six-digit pairing code.');
      busy = true;
      const version = generation;
      try {
        const result = await request(origin, '/v1/pair/claim', { data: { code, name: 'Atlas mobile' } });
        if (typeof result?.deviceToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.deviceToken) || !result.device?.id) throw new Error(SAFE_ERROR);
        if (version !== generation) return false;
        const next = { version: 1, origin, token: result.deviceToken };
        try { await vault.set({ key: KEY, value: JSON.stringify(next) }); }
        catch { throw new Error('Atlas could not save secure device access. Revoke this device in Atlas settings before pairing again.'); }
        if (version !== generation) {
          try { await vault.remove({ key: KEY }); }
          catch { throw new Error('Device access could not be removed. Revoke this device from Atlas settings.'); }
          return false;
        }
        record = next;
        return true;
      } finally { busy = false; }
    },
    async refresh() {
      if (!record) throw new Error('Pair this device to continue.');
      const version = generation;
      const current = record;
      const [tasks, approvals] = await Promise.all([
        request(current.origin, '/v1/tasks', { token: current.token }),
        request(current.origin, '/v1/approvals', { token: current.token }),
      ]);
      if (version !== generation) return null;
      if (!Array.isArray(tasks?.tasks) || !Array.isArray(approvals?.approvals)) throw new Error(SAFE_ERROR);
      // No backend messages, task internals or speculative approval buttons cross this projection.
      return { tasks: tasks.tasks.length, approvals: approvals.approvals.filter(item => item?.status === 'pending').length };
    },
    async disconnect() {
      generation += 1;
      record = null;
      try { await vault.remove({ key: KEY }); }
      catch { throw new Error('Device access could not be removed. Revoke this device from Atlas settings.'); }
    },
  };
}
