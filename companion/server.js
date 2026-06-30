/**
 * Companion server (cross-platform)
 * - Tails the BDS log (pure-Node implementation)
 * - Calls OpenAI for NPC replies
 * - Calls ElevenLabs for TTS audio
 * - Writes audio into resource_packs/CheatersRP/sounds/cheaters/voices/
 * - Creates a zip of the resource pack via 'archiver' and places it into ../dist/
 * - Serves the zip via express and notifies players (via RCON tellraw) with a download URL
 * - Uses RCON to playsound and run simple server commands
 *
 * Setup:
 *  - Copy companion/config.example.json -> companion/config.json and edit values
 *  - npm install
 *  - node server.js
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { stat, open } = fs.promises;
const { Rcon } = require('rcon-client');
const axios = require('axios');
const Archiver = require('archiver');
const express = require('express');
const { OpenAIApi, Configuration } = require('openai');

const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);

const cfgPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(cfgPath)) {
  console.error('Please create companion/config.json from config.example.json and set your API keys and paths.');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

if (!cfg.openai || !cfg.openai.apiKey) {
  console.error('Missing OpenAI apiKey in config.json');
  process.exit(1);
}
if (!cfg.elevenlabs || !cfg.elevenlabs.apiKey) {
  console.error('Missing ElevenLabs apiKey in config.json');
  process.exit(1);
}
if (!cfg.bdsLogPath) {
  console.error('Missing bdsLogPath in config.json');
  process.exit(1);
}
if (!cfg.rcon || !cfg.rcon.password) {
  console.error('Missing rcon settings in config.json');
  process.exit(1);
}

const openai = new OpenAIApi(new Configuration({ apiKey: cfg.openai.apiKey }));
const ELEVEN_API = cfg.elevenlabs.apiKey;
const resourcePackPath = path.resolve(__dirname, cfg.resourcePack.resourcePackPath || '../resource_packs/CheatersRP');
const soundsDir = path.join(resourcePackPath, 'sounds', 'cheaters', 'voices');
const distDir = path.join(__dirname, '..', 'dist');

const DEFAULT_HEAR_DISTANCE = cfg.chat && cfg.chat.hearDistance ? cfg.chat.hearDistance : 20;

(async () => {
  if (!fs.existsSync(soundsDir)) await mkdir(soundsDir, { recursive: true });
  if (!fs.existsSync(distDir)) await mkdir(distDir, { recursive: true });
})();

function log(...args) {
  if (cfg.debug) console.log(new Date().toISOString(), ...args);
}

function tailFile(filePath, onLine) {
  let fileDescriptor = null;
  let filePos = 0;
  let lastStat = null;

  async function openAndSeek() {
    try {
      const st = await stat(filePath);
      if (!lastStat) {
        filePos = st.size;
      } else {
        if (st.size < filePos) filePos = 0;
      }
      lastStat = st;
      if (!fileDescriptor) {
        fileDescriptor = await open(filePath, 'r');
      }
    } catch (err) {
      log('tail: waiting for log file to exist', filePath);
    }
  }

  async function readNew() {
    try {
      if (!fileDescriptor) {
        await openAndSeek();
        if (!fileDescriptor) return;
      }
      const st = await fileDescriptor.stat();
      if (st.size > filePos) {
        const length = st.size - filePos;
        const buf = Buffer.alloc(length);
        await fileDescriptor.read(buf, 0, length, filePos);
        filePos = st.size;
        const s = buf.toString('utf8');
        const lines = s.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const ln = lines[i];
          if (i === lines.length - 1 && s.charAt(s.length - 1) !== '\n' && s.charAt(s.length - 1) !== '\r') {
            filePos -= Buffer.from(ln, 'utf8').length;
            break;
          } else if (ln.length > 0) {
            onLine(ln);
          }
        }
      } else {
        if (st.ino !== lastStat.ino) {
          fileDescriptor.close().catch(() => {});
          fileDescriptor = null;
          filePos = 0;
          lastStat = st;
          await openAndSeek();
        }
      }
    } catch (err) {
      // ignore
    }
  }

  const interval = setInterval(readNew, 1000);
  const watcher = fs.watch(path.dirname(filePath), (eventType, filename) => {
    if (filename && filename === path.basename(filePath)) {
      openAndSeek().catch(() => {});
    }
  });
  openAndSeek().catch(() => {});
  return () => { clearInterval(interval); watcher.close(); if (fileDescriptor) fileDescriptor.close().catch(() => {}); };
}

function zipResourcePack(packDir, outZipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outZipPath);
    const archive = Archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => { log('Resource pack zipped', outZipPath, archive.pointer(), 'bytes'); resolve(outZipPath); });
    archive.on('warning', (err) => { console.warn('Archiver warning', err); });
    archive.on('error', (err) => { reject(err); });
    archive.pipe(output);
    archive.directory(packDir, false);
    archive.finalize();
  });
}

async function publishResourcePack(zipPath, rconClient) {
  if (!global._cheaters_server) {
    const app = express();
    const serveDir = path.dirname(zipPath);
    app.use('/', express.static(serveDir));
    const port = cfg.resourcePack.servePort || 3000;
    const server = app.listen(port, () => log(`Resourcepack server listening on http://localhost:${port}/`));
    global._cheaters_server = server;
  }
  const fileName = path.basename(zipPath);
  const url = (cfg.resourcePack && cfg.resourcePack.publicUrl) ? `${cfg.resourcePack.publicUrl}/${fileName}` : `http://${cfg.resourcePack.publicHost || 'YOUR_SERVER_IP'}:${cfg.resourcePack.servePort || 3000}/${fileName}`;
  const notifyCmd = `tellraw @a {"rawtext":[{"text":"Download updated resource pack to hear NPC voices: ${url}"}]}`;
  try {
    await rconClient.send(notifyCmd);
    log('Notified players to download resource pack:', url);
  } catch (e) {
    console.warn('Failed to send tellraw notify via RCON', e);
  }
  return url;
}

async function callOpenAIReply(npcName, playerMessage) {
  const prompt = `You are ${npcName}, a small NPC in a Minecraft Bedrock world. The player said: "${playerMessage}". Reply in 1 short sentence. At the start include an emotion tag like [joy] or [anger]. Output only the reply.`;
  const res = await openai.createChatCompletion({
    model: cfg.openai.model || 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.8,
    max_tokens: 120
  });
  return (res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message && res.data.choices[0].message.content) ? res.data.choices[0].message.content.trim() : '...';
}

async function callElevenLabsTTS(text) {
  const voice = cfg.elevenlabs.voice || 'alloy';
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice}`;
  const resp = await axios.post(url, { text }, {
    responseType: 'arraybuffer',
    headers: { 'xi-api-key': ELEVEN_API, 'Content-Type': 'application/json' },
    timeout: 60_000
  });
  return resp.data;
}

async function playCheaterSound(rconClient, hearDistance) {
  const playsoundCmd = `playsound cheaters.cheater_voice @a[r=${hearDistance}]`;
  try {
    await rconClient.send(playsoundCmd);
  } catch (e) {
    console.warn('playsound failed:', e);
  }
}

async function main() {
  log('Starting companion server (cross-platform)');
  let rconClient;
  try {
    rconClient = await Rcon.connect({
      host: cfg.rcon.host,
      port: cfg.rcon.port,
      password: cfg.rcon.password
    });
    rconClient.on('connect', () => log('RCON connected'));
    rconClient.on('error', (e) => console.error('RCON error', e));
  } catch (e) {
    console.error('Failed to connect RCON:', e);
    process.exit(1);
  }

  if (!fs.existsSync(distDir)) await mkdir(distDir, { recursive: true });

  tailFile(cfg.bdsLogPath, async (line) => {
    try {
      const chatRe = new RegExp(cfg.chat.chatRegex || '.*<(.+)> (.+)$');
      const cm = chatRe.exec(line);
      if (cm) {
        const player = cm[1];
        const message = cm[2];
        log('CHAT', player, message);
        const npcName = 'Cheater';
        let aiReply;
        try {
          aiReply = await callOpenAIReply(npcName, message);
        } catch (err) {
          console.error('OpenAI error', err.message || err);
          aiReply = '[neutral] ...';
        }
        try {
          await rconClient.send(`tellraw @a {"rawtext":[{"text":"[${npcName}] ${aiReply}"}]}`);
        } catch (e) {
          console.warn('tellraw failed', e);
        }
        let ttsBytes;
        try {
          ttsBytes = await callElevenLabsTTS(aiReply);
        } catch (err) {
          console.error('ElevenLabs TTS error', err.message || err);
          ttsBytes = null;
        }
        if (ttsBytes) {
          const id = Date.now() + '_' + Math.floor(Math.random() * 10000);
          const fname = `cheater_${id}.ogg`;
          const fpath = path.join(soundsDir, fname);
          await writeFile(fpath, Buffer.from(ttsBytes));
          log('Wrote TTS file', fpath);
          const zipPath = path.join(distDir, cfg.resourcePack.packFilename || 'CheatersRP_update.zip');
          await zipResourcePack(resourcePackPath, zipPath);
          const url = await publishResourcePack(zipPath, rconClient);
          await playCheaterSound(rconClient, cfg.chat.hearDistance || DEFAULT_HEAR_DISTANCE);
        }
      }
      const attackRe = new RegExp(cfg.chat.attackRegex || '.*\\[CHEATER_EVENT\\] attacked_by (.+)$');
      const am = attackRe.exec(line);
      if (am) {
        const player = am[1];
        log('ATTACK detected from', player);
        try {
          await rconClient.send(`summon zombie ${player}`);
          log('Summoned hostile zombie at', player);
        } catch (e) {
          console.warn('Failed to summon hostile via RCON', e);
        }
        let taunt;
        try {
          taunt = await callOpenAIReply('Cheater', `${player} attacked me. Taunt them in one line with emotion tag.`);
        } catch (err) {
          console.error('OpenAI taunt error', err.message || err);
          taunt = '[anger] You will pay!';
        }
        try {
          await rconClient.send(`tellraw @a {"rawtext":[{"text":"[Cheater] ${taunt}"}]}`);
        } catch (e) { }
        try {
          const ttsBytes2 = await callElevenLabsTTS(taunt);
          const id2 = Date.now() + '_' + Math.floor(Math.random() * 10000);
          const fname2 = `cheater_${id2}.ogg`;
          const fpath2 = path.join(soundsDir, fname2);
          await writeFile(fpath2, Buffer.from(ttsBytes2));
          log('Wrote TTS', fpath2);
          const zipPath2 = path.join(distDir, cfg.resourcePack.packFilename || 'CheatersRP_update.zip');
          await zipResourcePack(resourcePackPath, zipPath2);
          await publishResourcePack(zipPath2, rconClient);
          await playCheaterSound(rconClient, cfg.chat.hearDistance || DEFAULT_HEAR_DISTANCE);
        } catch (err) {
          console.error('ElevenLabs error (taunt)', err.message || err);
        }
      }
    } catch (err) {
      console.error('Error processing log line', err);
    }
  });
  log('Companion tailing logs:', cfg.bdsLogPath);
}

main().catch(err => { console.error('Fatal error in companion', err); process.exit(1); });
