import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Runs only on the macOS native CI runner. No accounts, tokens or network pairing.
const output = resolve('build/ios-launch');
mkdirSync(output, { recursive: true });
const app = resolve('build/ios/Build/Products/Debug-iphonesimulator/App.app');
if (!statSync(app).isDirectory()) throw new Error('Compiled simulator app is missing');
const { appId } = JSON.parse(readFileSync('capacitor.config.json', 'utf8'));
if (!/^[a-zA-Z0-9.]+$/.test(appId)) throw new Error('Invalid native bundle identifier');
function simctl(args, timeout = 30000) {
  return execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', timeout });
}
const inventory = JSON.parse(simctl(['list', 'devices', 'available', '--json']));
const candidate = Object.entries(inventory.devices).flatMap(([runtime, devices]) => devices.map(device => ({ ...device, runtime })))
  .find(device => device.isAvailable && device.name.startsWith('iPhone'));
if (!candidate) throw new Error('No available iPhone simulator runtime on this runner');
const device = { id: candidate.udid, name: candidate.name, runtime: candidate.runtime };
writeFileSync(resolve(output, 'device.json'), JSON.stringify(device, null, 2));
const startedHere = candidate.state !== 'Booted';
try {
  if (startedHere) simctl(['boot', device.id]);
  simctl(['bootstatus', device.id, '-b'], 240000);
  simctl(['install', device.id, app], 60000);
  const receipt = simctl(['launch', '--terminate-running-process', device.id, appId], 60000);
  writeFileSync(resolve(output, 'launch.txt'), receipt);
  if (!new RegExp(`${appId.replaceAll('.', '\\.')}:[ \\t]+[0-9]+`).test(receipt)) throw new Error('Simulator did not return an application launch receipt');
  await new Promise(resolve => setTimeout(resolve, 15000));
  simctl(['io', device.id, 'screenshot', resolve(output, 'launch.png')]);
  if (statSync(resolve(output, 'launch.png')).size === 0) throw new Error('Simulator screenshot is empty');
  console.log('Simulator launch receipt and screenshot captured. Review rendering independently; no pairing or approval acceptance is claimed.');
} finally {
  if (startedHere) { try { simctl(['shutdown', device.id]); } catch { /* Preserve the actual launch failure when cleanup also fails. */ } }
}
