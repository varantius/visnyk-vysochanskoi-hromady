// index.js — проверяет сайт громады и отправляет новые документы
// в Telegram-канал с хештегами посёлков.
//
// Обычный запуск:      node index.js
// Проверка без отправки: node index.js --dry

import { readFileSync, writeFileSync, existsSync } from "fs";
import * as cheerio from "cheerio";
import { classify, toHashtags } from "./classify.js";

// ---- Настройки -------------------------------------------------------------

const SITE = "https://vysochanska-rada.dosvit.org.ua";
const PAGE = `${SITE}/documents`;

const TOKEN = process.env.BOT_TOKEN;
const CHANNEL = process.env.CHANNEL; // например: @pokotylivka_news

const SENT_FILE = "sent.json";

// режим проверки: ничего не отправляем, только печатаем в консоль
const DRY_RUN = process.argv.includes("--dry");

// ---- Шаг 1. Скачать список документов ---------------------------------------

async function fetchDocuments() {
  const res = await fetch(PAGE, {
    headers: { "User-Agent": "Mozilla/5.0 (pokotylivka-bot)" },
  });

  if (!res.ok) throw new Error(`Сайт ответил ${res.status}`);

  const $ = cheerio.load(await res.text());
  const docs = [];

  // ЕДИНСТВЕННОЕ хрупкое место: зависит от вёрстки сайта.
  // Если в логах "Нашли документов: 0" — смотри исходник страницы
  // и правь селектор ниже.
  $('a[href*="/documents/"]').each((_, el) => {
    const href = $(el).attr("href");
    const title = $(el).text().trim().replace(/\s+/g, " ");

    const id = href.split("/documents/")[1];
    if (!id || id.length < 5) return;

    docs.push({
      id,
      title,
      url: href.startsWith("http") ? href : SITE + href,
    });
  });

  return [...new Map(docs.map((d) => [d.id, d])).values()];
}

// ---- Шаг 2. Память о том, что уже отправляли --------------------------------

function loadSent() {
  if (!existsSync(SENT_FILE)) return [];
  return JSON.parse(readFileSync(SENT_FILE, "utf8"));
}

function saveSent(ids) {
  writeFileSync(SENT_FILE, JSON.stringify(ids.slice(-500), null, 2));
}

// ---- Шаг 3. Отправка в Telegram ---------------------------------------------

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendToChannel(text) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: CHANNEL,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram отказал: ${data.description}`);
}

// ---- Главная ----------------------------------------------------------------

async function main() {
  if (!DRY_RUN && (!TOKEN || !CHANNEL)) {
    throw new Error("Не заданы BOT_TOKEN или CHANNEL");
  }
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Не задан GEMINI_API_KEY");
  }

  const docs = await fetchDocuments();
  console.log(`Нашли документов: ${docs.length}`);

  // Режим проверки: берём 10 последних и просто печатаем результат
  if (DRY_RUN) {
    console.log("\n--- РЕЖИМ ПРОВЕРКИ, ничего не отправляем ---\n");

    for (const doc of docs.slice(0, 10)) {
      console.log(`📄 ${doc.title}`);
      const { settlements, summary, raw } = await classify(doc.url, doc.title);
      console.log(`   модель вернула: ${JSON.stringify(raw)}`);
      console.log(`   после обработки: ${toHashtags(settlements)}`);
      console.log(`   пересказ: ${summary}\n`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    return;
  }

  const sent = loadSent();

  // Первый запуск: запоминаем всё, но ничего не шлём,
  // чтобы не завалить канал полусотней старых документов.
  if (sent.length === 0) {
    saveSent(docs.map((d) => d.id));
    console.log("Первый запуск — запомнили текущие документы.");
    return;
  }

  const fresh = docs.filter((d) => !sent.includes(d.id));
  console.log(`Из них новых: ${fresh.length}`);

  for (const doc of fresh) {
    console.log(`Обрабатываем: ${doc.title}`);

    const { settlements, summary } = await classify(doc.url, doc.title);

    const text =
      `📄 <b>${escapeHtml(doc.title)}</b>\n\n` +
      `${escapeHtml(summary)}\n\n` +
      `${doc.url}\n\n` +
      `${toHashtags(settlements)}`;

    await sendToChannel(text);
    sent.push(doc.id);

    // пауза, чтобы не упереться в лимиты Telegram и Gemini
    await new Promise((r) => setTimeout(r, 3000));
  }

  saveSent(sent);
  console.log("Готово.");
}

main().catch((err) => {
  console.error("Ошибка:", err.message);
  process.exit(1);
});
