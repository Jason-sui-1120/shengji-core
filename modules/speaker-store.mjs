// speaker-store.mjs —— core 仓库内的测试 shim（不在 core-sync 同步清单中，不会复制到消费端）。
// 真实实现由两端各自的 server/speaker-store.mjs 提供（公网 SQLite / 公司 MySQL，接口一致）。
export async function listProfiles() { return []; }
export async function findProfileByLabel() { return null; }
export async function insertProfile() { return { id: 0 }; }
export async function bumpProfileFeatures() {}
export async function setProfileFeatures() {}
export async function deleteProfileById() {}
export async function renameProfileLabel() {}
export async function getNextSpeakerLabel() { return "说话人 1"; }
