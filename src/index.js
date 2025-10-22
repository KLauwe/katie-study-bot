import 'dotenv/config';
import express from 'express';
import {
  Client,
  GatewayIntentBits,
  ActivityType,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  PermissionFlagsBits
} from 'discord.js';
import fs from 'fs/promises';
import path from 'path';

/* ======================= ENV ======================= */
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN in .env');
  process.exit(1);
}
const GUILD_ID = process.env.GUILD_ID || null;
const DATA_DIR = path.resolve('data');

/* ===================== CLIENT ====================== */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
process.on('unhandledRejection', e => console.error('🧯 UnhandledRejection:', e));
process.on('uncaughtException',  e => console.error('🧯 UncaughtException:', e));

/* ================ IN-MEMORY STATE ================== */
// channelId -> { index, bank, active, answered, scoreboard: Map<userId,pts>, collector?:Collector }
const sessions = new Map();
// guildId -> Map<bankName, Question[]>
const banks    = new Map();
// guildId -> last used bank name
const lastBank = new Map();

const SAMPLE_BANK = [
  { q: 'Which PPE items are required for contact precautions?', type: 'sata',  options: ['Gloves','Gown','N95 respirator','Eye protection'], answerIdx: [0,1], rationale: 'Contact = gloves + gown. N95 is airborne; eye protection is procedure-dependent.' },
  { q: 'Priority action for suspected sepsis on med-surg?',    type: 'single', options: ['Start enteral feeds','Obtain blood cultures','Start DVT prophylaxis','Give PRN lorazepam'], answerIdx: [1], rationale: 'Cultures before antibiotics.' },
  { q: 'Diabetes sick-day rule: Continue basal insulin.',       type: 'tf',     options: ['True','False'], answerIdx: [0], rationale: 'Prevents DKA.' }
];

function ensureGuildBank(guildId) {
  if (!banks.has(guildId)) {
    banks.set(guildId, new Map([['sample', SAMPLE_BANK]]));
    lastBank.set(guildId, 'sample');
  }
}

/* ==================== COMMANDS ===================== */
const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check if the bot is alive!'),
  new SlashCommandBuilder()
    .setName('quiz')
    .setDescription('Quiz controls')
    .addSubcommand(sc => sc.setName('start')
      .setDescription('Start a quiz in this channel')
      .addStringOption(o  => o.setName('bank').setDescription('Which question bank to use'))
      .addIntegerOption(o => o.setName('count').setDescription('How many questions').setMinValue(1).setMaxValue(100)))
    .addSubcommand(sc => sc.setName('stop').setDescription('Stop the current quiz in this channel'))
    .addSubcommand(sc => sc.setName('score').setDescription('Show the current scoreboard'))
    .addSubcommand(sc => sc.setName('list').setDescription('List available banks'))
    .addSubcommand(sc =>
      sc.setName('import')
        .setDescription('Import questions from a CSV file (admin only)')
        .addAttachmentOption(o => o.setName('file').setDescription('CSV file').setRequired(true))
        .addStringOption(o => o.setName('name').setDescription('Bank name (defaults to file name)')))
    .addSubcommand(sc => sc.setName('help').setDescription('Show quiz commands and usage tips'))
].map(c => c.toJSON());

/* ====================== READY ====================== */
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setPresence({ activities: [{ name: 'Study Mode', type: ActivityType.Competing }], status: 'online' });

  await ensureDataDir();
  await loadAllBanksFromDisk(); // auto-load saved banks

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
      console.log('✅ Guild commands registered: /ping, /quiz (start, stop, score, list, import, help)');
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      console.log('✅ Global commands registered (may take time): /ping, /quiz');
    }
  } catch (err) { console.error('Slash command registration failed:', err); }
});

/* ================== PERSISTENCE ==================== */
async function ensureDataDir() {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {}
}
function safeName(name) {
  return String(name).replace(/[^a-z0-9_\-\.]/gi, '_').slice(0, 80);
}
function bankPath(guildId, bankName) {
  return path.join(DATA_DIR, `${guildId}__${safeName(bankName)}.json`);
}
async function saveBankToDisk(guildId, bankName, items) {
  try {
    await ensureDataDir();
    await fs.writeFile(bankPath(guildId, bankName), JSON.stringify(items, null, 2), 'utf8');
    console.log(`💾 Saved bank "${bankName}" (${items.length} q) for guild ${guildId}`);
  } catch (e) {
    console.error('Save failed:', e);
  }
}
async function loadAllBanksFromDisk() {
  try {
    const files = await fs.readdir(DATA_DIR).catch(() => []);
    let loaded = 0;
    for (const f of files) {
      const m = /^(\d+)__.+\.json$/i.exec(f);
      if (!m) continue;
      const guildId = m[1];
      const name = f.replace(/^\d+__/, '').replace(/\.json$/i, '');
      const contents = await fs.readFile(path.join(DATA_DIR, f), 'utf8').catch(() => null);
      if (!contents) continue;
      const items = JSON.parse(contents);
      if (!Array.isArray(items) || items.length === 0) continue;
      ensureGuildBank(guildId);
      banks.get(guildId).set(name, items);
      if (!lastBank.get(guildId)) lastBank.set(guildId, name);
      loaded++;
    }
    if (loaded) console.log(`📚 Loaded ${loaded} bank file(s) from /data`);
  } catch (e) {
    console.error('Load failed:', e);
  }
}

/* ====================== UTILS ====================== */
const chunk = (arr, size) => { const out=[]; for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size)); return out; };
const normalize = s => (s ?? '').toString().trim();
const lettersToIdxArray = ans => ans.toUpperCase().replace(/,/g,';').split(';')
  .map(s=>s.trim()).filter(Boolean).map(ch=>{
    if (/^[A-Z]$/.test(ch)) return ch.charCodeAt(0)-65;
    if (/^\d+$/.test(ch)) return parseInt(ch,10)-1;
    return NaN;
  }).filter(n=>Number.isInteger(n)&&n>=0);

function validateQuestion(q) {
  const issues = [];
  if (!q.q) issues.push('missing prompt');
  if (!Array.isArray(q.options) || q.options.length < 2) issues.push('needs ≥2 options');
  if (q.options.length > 25) issues.push('≤25 options supported');
  if (!Array.isArray(q.answerIdx) || q.answerIdx.length === 0) issues.push('missing answer(s)');
  if (q.answerIdx.some(i => i < 0 || i >= q.options.length)) issues.push('answer index out of range');
  return issues;
}

function formatQuestionEmbed(qObj, idx, total, seconds = 20) {
  const embed = new EmbedBuilder()
    .setTitle(`🧠 Question ${idx + 1}/${total}`)
    .setDescription(qObj.q)
    .setColor(0x00AE86)
    .setFooter({ text: `Timer: ${seconds}s • First correct click scores` });
  const opts = qObj.options.map((o,i)=>`${String.fromCharCode(65+i)}. ${o}`).join('\n') || '—';
  embed.addFields({ name: 'Options', value: opts });
  return embed;
}
function buildButtons(qObj) {
  const buttons = qObj.options.map((_, i) =>
    new ButtonBuilder().setCustomId(`opt_${i}`).setLabel(String.fromCharCode(65+i)).setStyle(ButtonStyle.Primary)
  );
  return chunk(buttons, 5).map(group => new ActionRowBuilder().addComponents(...group));
}

/* ===================== CSV PARSER ================== */
function parseCsvRow(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i=0;i<line.length;i++){
    const ch=line[i];
    if (ch === '"'){ if(inQ && line[i+1]==='"'){cur+='"'; i++;} else inQ=!inQ; }
    else if (ch === ',' && !inQ){ out.push(cur); cur=''; }
    else cur+=ch;
  }
  out.push(cur); return out;
}
function parseCsvSmart(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l=>l.trim().length);
  if (!lines.length) return { items: [], meta: { rows: 0, headers: [] } };

  const headers = parseCsvRow(lines.shift()).map(h => h.trim().toLowerCase());
  const map = {};
  headers.forEach((h,i)=>{
    if (['question','prompt','stem'].includes(h)) map.question=i;
    if (['type','qtype'].includes(h)) map.type=i;
    if (['options','choices','opts'].includes(h)) map.options=i;
    if (['answer','answers','key','correct'].includes(h)) map.answer=i;
    if (['explanation','rationale','why'].includes(h)) map.explanation=i;
    if (!map.optCols) map.optCols = {};
    if (/^[a-z]$/.test(h)) map.optCols[h]=i; // allow a,b,c,d,... columns
  });

  const hasAnyOptions = (map.options !== undefined) || (map.optCols && Object.keys(map.optCols).length>0);
  if (map.question===undefined || !hasAnyOptions || map.answer===undefined) {
    throw new Error(`Headers must include at least: question, options (or a|b|c...), answer. Detected: ${headers.join(' | ')}`);
  }

  const letterOrder = 'abcdefghijklmnopqrstuvwxyz'.split('');
  const optLetterCols = letterOrder.filter(l => map.optCols && map.optCols[l] !== undefined).slice(0,25);

  const items = [];
  for (const raw of lines) {
    const cells = parseCsvRow(raw).map(s=>s.trim());
    const q = normalize(cells[map.question]);
    const t = normalize(cells[map.type] || 'single').toLowerCase();

    let options = [];
    if (map.options !== undefined) {
      const optionsStr = normalize(cells[map.options]);
      if (optionsStr.includes('|')) options = optionsStr.split('|');
      else if (optionsStr.includes(' ; ')) options = optionsStr.split(' ; ');
      else if (optionsStr.includes(';')) options = optionsStr.split(';');
      else options = [optionsStr];
    } else {
      options = optLetterCols.map(l => cells[map.optCols[l]]).filter(Boolean);
    }

    options = options.map(s => s.replace(/^[A-Z]\.\s*/i,'').trim()).filter(Boolean);
    if ((t==='tf'||t==='truefalse') && options.length===0) options=['True','False'];
    if (options.length>25) options=options.slice(0,25);

    const ansRaw = normalize(cells[map.answer]);
    let answerIdx = lettersToIdxArray(ansRaw).filter(i => i < options.length);
    if (!answerIdx.length && ansRaw) {
      const texts = ansRaw.split(/;|,|\|/).map(s=>s.trim().toLowerCase()).filter(Boolean);
      texts.forEach(txt => {
        const ix = options.findIndex(o => o.toLowerCase() === txt);
        if (ix >= 0) answerIdx.push(ix);
      });
    }

    const rationale = normalize(map.explanation!==undefined ? cells[map.explanation] : '');
    const row = { q, type: t, options, answerIdx, rationale };
    const issues = validateQuestion(row);
    if (!issues.length) items.push(row);
  }

  return { items, meta: { rows: lines.length, headers } };
}

/* ==================== QUIZ FLOW ==================== */
async function presentQuestion(interaction, session) {
  const q = session.bank[session.index];
  const issues = validateQuestion(q);
  if (issues.length) {
    await interaction.followUp({ content: `⚠️ Skipping invalid question (${issues.join(', ')}).`, ephemeral: true });
    session.index += 1;
    if (session.index < session.bank.length) return presentQuestion(interaction, session);
    session.active = false; await showScoreboard(interaction, session); sessions.delete(interaction.channelId); return;
  }

  const embed = formatQuestionEmbed(q, session.index, session.bank.length);
  const components = buildButtons(q);
  const msg = await interaction.followUp({ embeds: [embed], components });
  session.active = true; session.answered = false;

  const collector = msg.createMessageComponentCollector({ time: 20000 });
  session.collector = collector;

  collector.on('collect', async (btnInt) => {
    try {
      if (session.answered) return btnInt.reply({ content: 'This question already advanced. ⏭️', ephemeral: true });
      session.answered = true;

      const choice = parseInt(btnInt.customId.split('_')[1], 10);
      const correctSet = new Set(session.bank[session.index].answerIdx);
      const isCorrect = correctSet.has(choice);
      if (isCorrect) {
        const prev = session.scoreboard.get(btnInt.user.id) || 0;
        session.scoreboard.set(btnInt.user.id, prev + 1);
      }

      const lettersCorrect = [...correctSet].map(i => String.fromCharCode(65 + i)).join(', ');
      const rationale = session.bank[session.index].rationale || '—';
      await btnInt.update({
        content: (isCorrect ? '✅ Correct!' : '❌ Incorrect!') + `  **Answer:** ${lettersCorrect}\n> ${rationale}`,
        embeds: [],
        components: []
      });
      collector.stop('answered');
    } catch (e) {
      if (e?.code === 10062 || e?.rawError?.code === 10062 || e?.status === 404) return; // ignore expired/unknown
      console.error('Error handling button press:', e);
      try { await btnInt.reply({ content: '❌ Something went wrong (logged).', ephemeral: true }); } catch {}
      collector.stop('error');
    }
  });

  collector.on('end', async (_, reason) => {
    if (reason === 'manual-stop') return; // stopped by /quiz stop
    if (reason !== 'answered') await interaction.followUp({ content: '⏰ Time up! Moving on…' });
    session.index += 1;
    if (session.index < session.bank.length) return presentQuestion(interaction, session);
    session.active = false; await showScoreboard(interaction, session); sessions.delete(interaction.channelId);
  });
}

async function showScoreboard(interaction, session) {
  if (!session || session.scoreboard.size === 0) return interaction.followUp({ content: '📊 No scores yet.' });
  const sorted = [...session.scoreboard.entries()].sort((a,b)=>b[1]-a[1]);
  const lines = await Promise.all(sorted.map(async ([userId, pts], idx) => {
    const user = await interaction.client.users.fetch(userId).catch(()=>null);
    const name = user ? user.username : `User ${userId}`;
    return `${idx+1}. **${name}** — ${pts} pts`;
  }));
  return interaction.followUp({ content: `📊 **Scoreboard**\n${lines.join('\n')}` });
}

/* ================== INTERACTIONS =================== */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    return interaction.reply('Pong! 🏓');
  }

  if (interaction.commandName === 'quiz') {
    const sub = interaction.options.getSubcommand();
    ensureGuildBank(interaction.guildId);

    if (sub === 'help') {
      const help = [
        '**/quiz start** `bank:<name>` `count:<n>` – start a quiz (randomized).',
        '**/quiz stop** – stop the current quiz in this channel.',
        '**/quiz score** – show current scoreboard.',
        '**/quiz list** – list available banks.',
        '**/quiz import** `file:<csv>` `name:<optional>` – **admin only**.',
        '',
        'CSV tips:',
        '• Use headers like: `question, correct, rationale, a, b, c, d`  **or**',
        '• `question,type,options,answer,explanation` (options pipe-separated like `A|B|C|D`).',
        '• Answers can be letters (`A;C`), numbers (`1;3`), or exact option text.'
      ].join('\n');
      return interaction.reply({ content: help, ephemeral: true });
    }

    if (sub === 'list') {
      const map = banks.get(interaction.guildId);
      const entries = [...map.entries()].map(([name, arr]) => `• **${name}** — ${arr.length} q`);
      return interaction.reply({ content: entries.length ? entries.join('\n') : 'No banks yet. Use `/quiz import` (admin only).', ephemeral: true });
    }

    if (sub === 'stop') {
      const session = sessions.get(interaction.channelId);
      if (!session || !session.active) {
        return interaction.reply({ content: 'ℹ️ No quiz is running in this channel.', ephemeral: true });
      }
      try { session.collector?.stop('manual-stop'); } catch {}
      sessions.delete(interaction.channelId);
      return interaction.reply({ content: '🛑 **Quiz stopped.** Scoreboard cleared for this channel.' });
    }

    if (sub === 'import') {
      // ---- ADMIN-ONLY GUARD ----
      const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
      if (!isAdmin) {
        return interaction.reply({ content: '⛔ **Admin only:** You need the Administrator permission to use `/quiz import`.', ephemeral: true });
      }

      const attachment = interaction.options.getAttachment('file', true);
      let name = interaction.options.getString('name')?.trim();
      if (!name) name = attachment.name.replace(/\.[^/.]+$/, '');

      await interaction.reply({ content: `📥 Reading **${attachment.name}** as bank **${name}**…`, ephemeral: true });
      try {
        const res = await fetch(attachment.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const { items, meta } = parseCsvSmart(text);
        if (items.length === 0) {
          return interaction.followUp({ content: `⚠️ No valid rows found.\nDetected headers: \`${meta.headers.join(' | ')}\`\nRows read: ${meta.rows}\nHint: include **question**, **options (or a|b|c...)**, **answer**.`, ephemeral: true });
        }
        const map = banks.get(interaction.guildId);
        map.set(name, items);
        lastBank.set(interaction.guildId, name);
        await saveBankToDisk(interaction.guildId, name, items);
        await interaction.followUp({ content: `✅ Imported **${items.length}** questions into bank **${name}**. Try: \`/quiz start bank:${name}\``, ephemeral: true });
      } catch (e) {
        console.error('Import error:', e);
        await interaction.followUp({ content: `❌ Import failed: ${e.message}`, ephemeral: true });
      }
      return;
    }

    if (sub === 'start') {
      const requested    = interaction.options.getString('bank')?.trim();
      const desiredCount = interaction.options.getInteger('count') ?? null;
      const map = banks.get(interaction.guildId);

      let chosenName = requested || lastBank.get(interaction.guildId);
      if (!chosenName && map.size === 1) chosenName = [...map.keys()][0];

      if (!chosenName) {
        const options = [...map.keys()].slice(0,25).map(name => ({
          label: name, value: name, description: `${map.get(name).length} questions`
        }));
        const menu = new StringSelectMenuBuilder().setCustomId('bank_select').setPlaceholder('Choose a question bank').addOptions(options);
        await interaction.reply({ content: 'Please choose a bank to start:', components: [ new ActionRowBuilder().addComponents(menu) ], ephemeral: true });

        const msg = await interaction.fetchReply();
        const collector = msg.createMessageComponentCollector({ time: 20000 });
        collector.on('collect', async (sel) => {
          if (sel.customId !== 'bank_select') return;
          const picked = sel.values[0];
          await sel.update({ content: `Starting **${picked}**…`, components: [] });
          lastBank.set(interaction.guildId, picked);
          return actuallyStart(interaction, map.get(picked), desiredCount);
        });
        collector.on('end', async (c) => { if (c.size === 0) try { await interaction.editReply({ content: '⏰ No bank selected.', components: [] }); } catch {} });
        return;
      }

      const bank = map.get(chosenName);
      if (!bank) return interaction.reply({ content: `❌ Bank **${requested || chosenName}** not found. Use \`/quiz list\`.`, ephemeral: true });
      lastBank.set(interaction.guildId, chosenName);
      return actuallyStart(interaction, bank, desiredCount);
    }

    if (sub === 'score') {
      const session = sessions.get(interaction.channelId) || { scoreboard: new Map() };
      await interaction.reply({ content: 'Fetching scores…', ephemeral: true });
      await showScoreboard(interaction, session);
    }
  }
});

async function actuallyStart(interaction, bankArr, desiredCount) {
  if (!bankArr || bankArr.length === 0) return interaction.followUp({ content: '⚠️ Selected bank has no questions.', ephemeral: true });
  if (sessions.has(interaction.channelId)) return interaction.followUp({ content: '⚠️ A quiz is already running in this channel.', ephemeral: true });

  const shuffled = [...bankArr].sort(() => Math.random() - 0.5);
  const count    = desiredCount ? Math.max(1, Math.min(desiredCount, shuffled.length)) : shuffled.length;
  const selected = shuffled.slice(0, count);

  const session = { index: 0, bank: selected, active: false, answered: false, scoreboard: new Map(), collector: null };
  sessions.set(interaction.channelId, session);

  const msg = `🎬 **Quiz starting!** ${count} question${count>1?'s':''}. First correct click gets the point. ⏱️ 20s per question.`;
  if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: msg });
  else await interaction.followUp({ content: msg });

  await presentQuestion(interaction, session);
}

client.login(process.env.DISCORD_TOKEN);

// --- Tiny web server for Render (prevents free tier sleep) ---
const app = express();
app.get('/', (_req, res) => {
  res.send('Katie Study Bot is running ✅');
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web heartbeat listening on :${PORT}`));



