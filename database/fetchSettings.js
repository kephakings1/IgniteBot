const { getSettings } = require('./config');

async function fetchSettings() {
  const data = await getSettings();
  return {
    wapresence:  data.wapresence  || 'online',
    autoread:    data.autoread    || 'off',
    mode:        data.mode        || 'public',
    prefix:      data.prefix      || '.',
    autolike:    data.autolike    || 'on',
    autoview:    data.autoview    || 'on',
    antilink:    data.antilink    || 'on',
    antilinkall: data.antilinkall || 'off',
    antidelete:  data.antidelete  || 'on',
    antitag:     data.antitag     || 'on',
    antibot:     data.antibot     || 'off',
    welcome:     data.welcome     || 'off',
    autobio:     data.autobio     || 'off',
    badword:     data.badword     || 'on',
    gptdm:       data.gptdm       || 'off',
    anticall:    data.anticall    || 'off',
  };
}

module.exports = fetchSettings;
