// api/ai.js — Vercel Serverless Function
// Gemini 2.0 Flash kullanır (Google, ücretsiz katman — kart gerekmez)
//
// Vercel Dashboard > Project > Settings > Environment Variables:
//   GEMINI_API_KEY = AIza...  (https://aistudio.google.com/app/apikey)

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY not configured" });
  }

  const { messages = [], system = "" } = req.body || {};

  // Anthropic formatındaki mesajları Gemini formatına dönüştür
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: 1024,
      temperature: 0.7,
    },
  };

  // Sistem mesajı varsa ekle
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      return res.status(geminiRes.status).json({
        error: data.error?.message || "Gemini API hatası",
      });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // HTML tarafının beklediği Anthropic formatında yanıt dön
    return res.status(200).json({
      content: [{ type: "text", text }],
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
