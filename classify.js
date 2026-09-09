// classify.js — определяет, каких посёлков касается документ,
// и делает короткий пересказ. Работает на бесплатном Gemini API.

import * as cheerio from "cheerio";

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash"; // Flash доступен на бесплатном тарифе

// Правильные названия — так они будут выглядеть в хештегах
const SETTLEMENTS = [
  "Високий",
  "Бабаї",
  "Покотилівка",
  "Затишне",
  "Нова Березівка",
  "Ржавець",
];

// Основы слов — то, что не меняется при склонении.
// Нужно, чтобы "Покотилівки", "у Покотилівці" превратились в "Покотилівка".
const STEMS = {
  висок: "Високий",
  баба: "Бабаї",
  покотилівк: "Покотилівка",
  затишн: "Затишне",
  березівк: "Нова Березівка",
  ржав: "Ржавець",
};

// ---- Нормализация названия --------------------------------------------------

function normalize(name) {
  if (typeof name !== "string") return null;

  const clean = name
    .toLowerCase()
    .replace(/^(смт|с\.|м\.|селище|село|місто)\s*/i, "") // убрать "смт", "с."
    .replace(/['’ʼ]/g, "") // апострофы в разных начертаниях
    .trim();

  if (clean.includes("громад")) return "ВсяГромада";

  for (const [stem, proper] of Object.entries(STEMS)) {
    if (clean.includes(stem)) return proper;
  }

  return null; // незнакомое название — выбрасываем
}

// ---- Работа с PDF -----------------------------------------------------------

async function findPdfUrl(docPageUrl) {
  const res = await fetch(docPageUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (pokotylivka-bot)" },
  });
  const $ = cheerio.load(await res.text());

  const link = $('a[href$=".pdf"]').first().attr("href");
  if (!link) return null;

  return link.startsWith("http") ? link : new URL(link, docPageUrl).href;
}

async function downloadPdfAsBase64(pdfUrl) {
  const res = await fetch(pdfUrl);
  const buffer = Buffer.from(await res.arrayBuffer());

  if (buffer.length > 15 * 1024 * 1024) return null; // слишком большой

  return buffer.toString("base64");
}

// ---- Запрос к Gemini с повтором при лимите ----------------------------------

async function callGemini(body, attempt = 1) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${MODEL}:generateContent?key=${API_KEY}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  // 429 = слишком часто. Ждём и пробуем ещё раз, до 4 раз.
  if (res.status === 429 && attempt <= 4) {
    const wait = 2000 * attempt;
    console.log(`   лимит запросов, ждём ${wait / 1000}с...`);
    await new Promise((r) => setTimeout(r, wait));
    return callGemini(body, attempt + 1);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini ответил ${res.status}: ${errText.slice(0, 200)}`);
  }

  return res.json();
}

// ---- Главная функция --------------------------------------------------------

export async function classify(docPageUrl, title) {
  // если что-то пойдёт не так — вернём это
  const fallback = { settlements: ["ВсяГромада"], summary: title, raw: null };

  try {
    const pdfUrl = await findPdfUrl(docPageUrl);
    if (!pdfUrl) return fallback;

    const pdfBase64 = await downloadPdfAsBase64(pdfUrl);
    if (!pdfBase64) return fallback;

    const prompt = `Ти аналізуєш документ Височанської селищної ради.

Населені пункти громади: ${SETTLEMENTS.join(", ")}.

Завдання:
1. Визнач, яких населених пунктів СТОСУЄТЬСЯ цей документ.
   Проста згадка назви — це ще не "стосується".
   Якщо документ загальний (бюджет, програма, штатний розпис) —
   поверни ["ВсяГромада"].
   Якщо не впевнений — теж поверни ["ВсяГромада"].
2. Назви повертай СУВОРО у називному відмінку, точно як у списку вище,
   навіть якщо в документі вони стоять в іншому відмінку
   (наприклад "Покотилівки", "у Покотилівці" → "Покотилівка").
3. Напиши переказ рішення однією-двома фразами простою мовою,
   без канцеляриту. Не вигадуй цифр, яких немає в документі.`;

    const data = await callGemini({
      contents: [
        {
          parts: [
            {
              inline_data: {
                mime_type: "application/pdf",
                data: pdfBase64,
              },
            },
            { text: prompt },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            settlements: {
              type: "ARRAY",
              items: {
                type: "STRING",
                // модель физически не сможет вернуть что-то другое
                enum: [...SETTLEMENTS, "ВсяГромада"],
              },
            },
            summary: { type: "STRING" },
          },
          required: ["settlements", "summary"],
        },
      },
    });

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return fallback;

    const parsed = JSON.parse(text);

    // Вторая линия защиты: нормализуем на случай, если enum не сработал.
    // Set убирает дубли ("Покотилівка" и "Покотилівки" → одно и то же).
    const valid = [
      ...new Set((parsed.settlements || []).map(normalize).filter(Boolean)),
    ];

    return {
      settlements: valid.length ? valid : ["ВсяГромада"],
      summary: parsed.summary || title,
      raw: parsed.settlements, // сырой ответ — пригодится для проверки
    };
  } catch (err) {
    console.log(`   не вышло разобрать: ${err.message}`);
    return fallback;
  }
}

// Превращает список посёлков в строку хештегов
export function toHashtags(settlements) {
  return settlements.map((s) => "#" + s.replace(/\s+/g, "")).join(" ");
}
