const { google } = require("googleapis");

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || "1B1q6Z132FMjiguerrFPC0V7yiG3M61z6nHTGg2m2G48";

function getAuthClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

function colToLetter(col) {
  let letter = "";
  while (col > 0) {
    const rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

async function getSheetsClient() {
  const auth = getAuthClient();
  return google.sheets({ version: "v4", auth });
}

async function getSheetData(sheets, sheetName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: sheetName,
  });
  const values = res.data.values || [];
  if (values.length === 0) return { headers: [], rows: [], rowNumbers: [] };
  const headers = values[0].map((h) => String(h));
  const rows = values.slice(1);
  // Her satırın gerçek Sheets satır numarasını döndür (1-based, header=1)
  const rowNumbers = rows.map((_, i) => i + 2);
  return { headers, rows, rowNumbers };
}

async function writeNotification(sheets, { tur, oyun, kisi, gorev, aciklama }) {
  try {
    const now = new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "BİLDİRİMLER",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[now, tur, oyun || "", kisi || "", gorev || "", aciklama || "Web uygulamasından"]] },
    });
  } catch (err) {
    console.error("Notification write error (non-fatal):", err);
  }
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allowedOrigins = [
    "https://izmir-dt.github.io",
    "http://localhost:5173",
    "http://localhost:3000",
  ];

  // null = yerel dosya (file://), boş = origin header yok
  if (allowedOrigins.includes(origin) || !origin || origin === "null") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "https://izmir-dt.github.io");
  }

  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathParts = url.pathname.replace(/^\/api\/sheets\/?/, "").split("/");
  const sheetName = pathParts[0] ? decodeURIComponent(pathParts[0]) : null;
  const action = pathParts[1];

  try {
    const sheets = await getSheetsClient();

    if (!sheetName && req.method === "GET") {
      const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
      const names = (meta.data.sheets || []).map((s) => s.properties?.title || "");
      return res.json({ sheets: names });
    }

    if (sheetName && !action && req.method === "GET") {
      try {
        const data = await getSheetData(sheets, sheetName);
        return res.json(data);
      } catch (err) {
        const msg = err?.message || "";
        if (msg.includes("Unable to parse range") || msg.includes("not found") || err?.code === 400) {
          return res.status(404).json({ headers: [], rows: [], error: "Sheet not found" });
        }
        throw err;
      }
    }

    if (sheetName && action === "meta" && req.method === "GET") {
      const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
      const sheet = meta.data.sheets?.find((s) => s.properties?.title === sheetName);
      return res.json({ sheet: sheet?.properties || null });
    }

    if (sheetName && action === "cell" && req.method === "PUT") {
      const { row, col, value } = req.body;
      let oldRowData = null;
      if (sheetName === "BÜTÜN OYUNLAR") {
        try { const d = await getSheetData(sheets, sheetName); oldRowData = d.rows[row - 2] || null; // row=_sheetRow(1-tabanlı), rows[0]=satır2 } catch {}
      }
      const colLetter = colToLetter(col + 1);
      const cellRef = `${sheetName}!${colLetter}${row}`; // row=_sheetRow, doğrudan A1 notasyonu
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: cellRef,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[value]] },
      });
      if (sheetName === "BÜTÜN OYUNLAR" && oldRowData) {
        await writeNotification(sheets, {
          tur: "GÜNCELLENDİ",
          oyun: String(oldRowData[0] || ""),
          kisi: String(oldRowData[3] || ""),
          gorev: String(oldRowData[2] || ""),
          aciklama: `${oldRowData[3] || oldRowData[0] || "Kayıt"} güncellendi`,
        });
      }
      return res.json({ success: true });
    }

    if (sheetName && action === "row" && req.method === "POST" && !pathParts[2]) {
      const { values } = req.body;
      const doAppend = async () => {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: sheetName,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [values] },
        });
      };
      try {
        await doAppend();
      } catch (appendErr) {
        const msg = appendErr?.message || "";
        if (msg.includes("Unable to parse range") || appendErr?.code === 400) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
          });
          await doAppend();
        } else throw appendErr;
      }
      if (sheetName === "BÜTÜN OYUNLAR" && Array.isArray(values)) {
        await writeNotification(sheets, {
          tur: "EKLENDİ", oyun: values[0] || "", kisi: values[3] || "", gorev: values[2] || "",
          aciklama: [values[3], values[0], values[2]].filter(Boolean).join(" • ") + " eklendi",
        });
      }
      return res.json({ success: true });
    }

    if (sheetName && action === "row" && pathParts[2] === "insert" && req.method === "POST") {
      const { afterRow, values } = req.body;
      const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
      const sheet = meta.data.sheets?.find((s) => s.properties?.title === sheetName);
      if (!sheet) return res.status(404).json({ error: "Sheet not found" });
      const sheetId = sheet.properties?.sheetId;
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { requests: [{ insertDimension: { range: { sheetId, dimension: "ROWS", startIndex: afterRow + 2, endIndex: afterRow + 3 }, inheritFromBefore: true } }] },
      });
      const colCount = values.length;
      const cellRef = `${sheetName}!A${afterRow + 3}:${colToLetter(colCount)}${afterRow + 3}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID, range: cellRef, valueInputOption: "USER_ENTERED",
        requestBody: { values: [values] },
      });
      return res.json({ success: true });
    }

    if (sheetName && action === "row" && pathParts[2] && req.method === "DELETE") {
      // pathParts[2] = _sheetRow = 1-tabanlı Sheets satır numarası (örn: 5 = 5. satır)
      const sheetRowNumber = parseInt(pathParts[2]);
      // deleteDimension 0-tabanlı index bekler: satır 5 → index 4
      const zeroBasedIndex = sheetRowNumber - 1;
      let deletedRow = null;
      if (sheetName === "BÜTÜN OYUNLAR") {
        try {
          const d = await getSheetData(sheets, sheetName);
          // d.rows[0] = Sheets satır 2 (header hariç), d.rows[n] = Sheets satır n+2
          deletedRow = d.rows[sheetRowNumber - 2] || null;
        } catch {}
      }
      const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
      const sheet = meta.data.sheets?.find((s) => s.properties?.title === sheetName);
      if (!sheet) return res.status(404).json({ error: "Sheet not found" });
      const sheetId = sheet.properties?.sheetId;
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: zeroBasedIndex, endIndex: zeroBasedIndex + 1 } } }] },
      });
      if (deletedRow) {
        await writeNotification(sheets, {
          tur: "SİLİNDİ", oyun: String(deletedRow[0] || ""), kisi: String(deletedRow[3] || ""), gorev: String(deletedRow[2] || ""),
          aciklama: [deletedRow[3], deletedRow[0], deletedRow[2]].filter(Boolean).join(" • ") + " silindi",
        });
      }
      return res.json({ success: true });
    }

    return res.status(404).json({ error: "Not found" });
  } catch (err) {
    console.error("API Error:", err);
    return res.status(500).json({ error: err.message });
  }
}
