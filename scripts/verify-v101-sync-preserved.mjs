import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const baseline = await readFile(new URL("../DENTYAR_V100_FINAL_SYNC_FIX.html", import.meta.url), "utf8");
const integrated = await readFile(new URL("../DENTYAR_V101_LICENSED_227.html", import.meta.url), "utf8");

function syncScript(source) {
  const start = source.indexOf("<script>\n(function(){\n  const SYNC = {};");
  assert.notEqual(start, -1, "SYNC script exists");
  const end = source.indexOf("\n</script>", start);
  assert.notEqual(end, -1, "SYNC script closes");
  return source.slice(start, end);
}
function sliceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, "Missing marker: " + startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, "Missing end marker: " + endNeedle);
  return source.slice(start, end).trim();
}
const oldSync = syncScript(baseline);
const newSync = syncScript(integrated);

const oldPush = sliceBetween(oldSync, "async function doPush(force){", "\n  SYNC.renderStatus = function");
const newPush = sliceBetween(newSync, "async function doPush(force){", "\n  SYNC.syncNow = async function");
assert.equal(newPush, oldPush, "The proven V101 parallel push engine must remain byte-for-byte unchanged");

const oldMerge = sliceBetween(oldSync, "function mergeValue(name, val){", "\n  SYNC.schedulePush = function");
const newMerge = sliceBetween(newSync, "function mergeValue(name, val){", "\n  SYNC.schedulePush = function");
assert.equal(newMerge, oldMerge, "The proven V101 parallel value-merge logic must remain unchanged");

for (const marker of ["SYNC.requestLicense = async function", "SYNC.redeemLicense = async function", "signInWithCustomToken", "claims.role!=='clinic-device'", "claims.deviceId!==expectedDeviceId"]) {
  assert.ok(newSync.includes(marker), "Missing licensing/auth control: " + marker);
}
assert.ok(newSync.includes("maxlength=\"16\""), "16-character activation input is present");
assert.ok(newSync.includes("function base(){ return 'clinics/'+String((SYNC.cfg() && SYNC.cfg().clinicCode)||'').trim(); }"), "Original clinic path is preserved exactly");
assert.ok(!newSync.includes("function base(){ return 'clinics/'+normalizeClinicCode"), "No silent clinic-path conversion");
assert.ok(!newSync.includes("signInWithEmailAndPassword"), "Legacy email/password sign-in is not used under licensed rules");
assert.ok(integrated.includes("پوستر رسمی معرفی دنت‌یار"), "Official poster is included");
assert.ok(integrated.includes('const DENTYAR_APP_VERSION = "V101.227"'), "Version is V101.227");
assert.ok(!integrated.includes("BEGIN PRIVATE KEY"), "No private key is embedded in the app");

console.log("V101.227 integration guard: stable push and merge logic preserved; licensed auth, exact clinic path, 16-character code and poster verified.");
