import { Capacitor, CapacitorHttp, registerPlugin } from './vendor/capacitor.js';
import { createDeviceClient } from './device-client.mjs';
const status = document.querySelector('#status');
const form = document.querySelector('form');
const dashboard = document.querySelector('#dashboard');
const refresh = document.querySelector('#refresh');
const disconnect = document.querySelector('#disconnect');
const retrySetup = document.querySelector('#retry-setup');
let initializing = false;
const vault = registerPlugin('SecureStoragePlugin');
let client;
function message(text) { status.textContent = text; }
function paired(value) { form.hidden = value; dashboard.hidden = !value; }
async function update() {
  refresh.disabled = true;
  message('Checking Atlas…');
  try {
    const result = await client.refresh();
    if (!result) return;
    document.querySelector('#tasks').textContent = String(result.tasks);
    document.querySelector('#approvals').textContent = String(result.approvals);
    message('Updated just now.');
  } catch (error) { message(error.message); }
  finally { refresh.disabled = false; }
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!client || initializing) return;
  const button = form.querySelector('button');
  button.disabled = true;
  message('Pairing securely…');
  try {
    if (await client.pair({ origin: form.elements.origin.value, code: form.elements.code.value })) { paired(true); await update(); }
  } catch (error) {
    message(error.message);
    if (error.code === 'SECURE_STORAGE_UNAVAILABLE') { form.hidden = true; retrySetup.hidden = false; }
  }
  finally { form.elements.code.value = ''; button.disabled = false; }
});
refresh.addEventListener('click', update);
disconnect.addEventListener('click', async () => {
  try { await client.disconnect(); paired(false); message('Disconnected on this device. You can also revoke it in Atlas device settings.'); }
  catch (error) { paired(false); message(error.message); }
});
async function setup() {
  if (initializing) return;
  initializing = true; retrySetup.disabled = true; retrySetup.hidden = true;
  form.hidden = true; dashboard.hidden = true;
  message('Checking secure device access…');
  try {
    const restored = await client.restore(); paired(restored);
    if (restored) await update(); else message('Pair with your Atlas owner device to get started.');
  } catch (error) {
    message(error.message);
    if (error.code === 'SECURE_STORAGE_UNAVAILABLE') retrySetup.hidden = false;
    else paired(false);
  } finally { initializing = false; retrySetup.disabled = false; }
}
retrySetup.addEventListener('click', setup);
if (!Capacitor.isNativePlatform()) {
  form.hidden = true;
  message('Open the installed Atlas mobile app to pair securely.');
} else {
  client = createDeviceClient({ http: CapacitorHttp, vault });
  await setup();
}
