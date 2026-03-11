const db = require("./datastore");

const DEFAULTS = { welcomeMessages: {}, goodbyeMessages: {}, groupData: {} };

function setWelcomeMessage(groupJid, message) {
  db.update("groups", DEFAULTS, (data) => {
    data.welcomeMessages[groupJid] = message;
  });
}

function getWelcomeMessage(groupJid) {
  const data = db.read("groups", DEFAULTS);
  return data.welcomeMessages[groupJid] || null;
}

function setGoodbyeMessage(groupJid, message) {
  db.update("groups", DEFAULTS, (data) => {
    data.goodbyeMessages[groupJid] = message;
  });
}

function getGoodbyeMessage(groupJid) {
  const data = db.read("groups", DEFAULTS);
  return data.goodbyeMessages[groupJid] || null;
}

function formatDateTime() {
  const now = new Date();
  const date = now.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
  const time = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
  return { date, time };
}

async function getProfilePicture(sock, jid) {
  try {
    const url = await sock.profilePictureUrl(jid, "image");
    const axios = require("axios");
    const res = await axios.get(url, { responseType: "arraybuffer", timeout: 8000 });
    return Buffer.from(res.data);
  } catch {
    return null;
  }
}

async function sendWelcome(sock, groupJid, newMemberJid) {
  try {
    const meta = await sock.groupMetadata(groupJid);
    const participant = meta.participants.find((p) => p.id === newMemberJid);
    const name = participant?.notify || newMemberJid.split("@")[0];
    const phone = newMemberJid.split("@")[0].split(":")[0];
    const { date, time } = formatDateTime();

    const customTemplate = getWelcomeMessage(groupJid);
    const caption = customTemplate
      ? customTemplate.replace(/{{name}}/g, name).replace(/{{group}}/g, meta.subject)
      : `🎉 *Welcome to ${meta.subject}!* 🎉\n\n` +
        `👤 *Name:* ${name}\n` +
        `📞 *Number:* +${phone}\n` +
        `📅 *Date:* ${date}\n` +
        `🕐 *Time:* ${time}\n\n` +
        `Please read the group rules and enjoy your stay! 😊\n\n` +
        `_Powered by Nexus V2_ ⚡`;

    const profilePic = await getProfilePicture(sock, newMemberJid);

    if (profilePic) {
      await sock.sendMessage(groupJid, {
        image: profilePic,
        caption,
        mentions: [newMemberJid],
      });
    } else {
      await sock.sendMessage(groupJid, {
        text: caption,
        mentions: [newMemberJid],
      });
    }
  } catch (err) {
    console.error("Welcome message error:", err.message);
  }
}

async function sendGoodbye(sock, groupJid, removedMemberJid) {
  try {
    const phone = removedMemberJid.split("@")[0].split(":")[0];
    const { date, time } = formatDateTime();

    const customTemplate = getGoodbyeMessage(groupJid);
    const caption = customTemplate
      ? customTemplate.replace(/{{name}}/g, phone)
      : `😂 *Bye Stupid Lad!* 👋\n\n` +
        `📞 *Number:* +${phone}\n` +
        `📅 *Date:* ${date}\n` +
        `🕐 *Time:* ${time}\n\n` +
        `Another one bites the dust! 💨\n` +
        `Don't let the door hit you on the way out 😂\n\n` +
        `_Nexus V2_ ⚡`;

    const profilePic = await getProfilePicture(sock, removedMemberJid);

    if (profilePic) {
      await sock.sendMessage(groupJid, {
        image: profilePic,
        caption,
        mentions: [removedMemberJid],
      });
    } else {
      await sock.sendMessage(groupJid, {
        text: caption,
        mentions: [removedMemberJid],
      });
    }
  } catch (err) {
    console.error("Goodbye message error:", err.message);
  }
}

async function tagAll(sock, groupJid, message = "") {
  try {
    const meta = await sock.groupMetadata(groupJid);
    const mentions = meta.participants.map((p) => p.id);
    const tags = mentions.map((jid) => `@${jid.split("@")[0]}`).join(" ");
    await sock.sendMessage(groupJid, {
      text: `${message}\n${tags}`,
      mentions,
    });
  } catch (err) {
    throw new Error(`Tag all failed: ${err.message}`);
  }
}

async function getGroupInfo(sock, groupJid) {
  try {
    const meta = await sock.groupMetadata(groupJid);
    const admins = meta.participants.filter((p) => p.admin).map((p) => p.id);
    return {
      name: meta.subject,
      description: meta.desc,
      memberCount: meta.participants.length,
      admins: admins.length,
      creation: new Date(meta.creation * 1000).toLocaleDateString(),
    };
  } catch {
    return null;
  }
}

module.exports = {
  setWelcomeMessage,
  getWelcomeMessage,
  setGoodbyeMessage,
  getGoodbyeMessage,
  sendWelcome,
  sendGoodbye,
  tagAll,
  getGroupInfo,
};
