// api/ai.js — Vercel Serverless Function
// Groq (Llama 3.3 70B) kullanır — tamamen ücretsiz, kart gerekmez
//
// Vercel Dashboard > Project > Settings > Environment Variables:
//   GROQ_API_KEY = gsk_...  (https://console.groq.com → API Keys → Create)

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GROQ_API_KEY not configured" });
  }

  const { messages = [], system = "" } = req.body || {};

  // Sistem mesajını başa ekle
  const groqMessages = [];
  if (system) {
    groqMessages.push({ role: "system", content: system });
  }
  groqMessages.push(...messages);

  try {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: groqMessages,
        max_tokens: 1024,
        temperature: 0.7,
      }),
    });

    const data = await groqRes.json();

    if (!groqRes.ok) {
      return res.status(groqRes.status).json({
        error: data.error?.message || "Groq API hatası",
      });
    }

    const text = data.choices?.[0]?.message?.content || "";

    // HTML tarafının beklediği Anthropic formatında yanıt dön
    return res.status(200).json({
      content: [{ type: "text", text }],
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
