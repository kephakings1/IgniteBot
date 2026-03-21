const fs   = require('fs');
const path = require('path');
const { getGroupSetting } = require('../database/config');

module.exports = async (client, m) => {
  try {
    if (!m || !m.isGroup) return;

    const jid = m.chat;
    let groupSettings;
    try {
      groupSettings = await getGroupSetting(jid);
    } catch {
      groupSettings = { antidelete: false };
    }

    if (!groupSettings || !groupSettings.antidelete) return;

    const proto = m.message && m.message.protocolMessage;
    if (!proto || proto.type !== 0) return;

    console.log('🗑️  Deleted message detected!');
    const key = proto.key;

    // Try to retrieve the deleted message from the store file
    try {
      const storePath = path.join(process.cwd(), 'store', 'store.json');
      if (!fs.existsSync(storePath)) return;

      const jsonData = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      const messages = jsonData.messages && jsonData.messages[key.remoteJid];
      if (!messages) return;

      let deletedMsg;
      for (const msg of messages) {
        if (msg.key && msg.key.id === key.id) {
          deletedMsg = msg;
          break;
        }
      }

      if (!deletedMsg) {
        return console.log('⚠️  Could not retrieve deleted message from store');
      }

      await client.sendMessage(jid, { forward: deletedMsg }, { quoted: deletedMsg });
    } catch (e) {
      console.log('antidelete error:', e.message);
    }
  } catch (err) {
    console.log('antidelete handler error:', err.message);
  }
};
