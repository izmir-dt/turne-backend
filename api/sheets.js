const { google } = require("googleapis");

const SPREADSHEET_ID = "1B1q6Z132FMjiguerrFPC0V7yiG3M61z6nHTGg2m2G48";

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
  const rows = values.slice(1).map((row) =>
    row.map((cell) => {
      if (cell === null || cell === undefined) return "";
      return String(cell);
    })
  );
  const rowNumbers = rows.map((_, i) => i + 2);
  return { headers, rows, rowNumbers };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathParts = url.pathname.replace(/^\/api\/sheets\/?/, "").split("/");
  const sheetName = pathParts[0] ? decodeURIComponent(pathParts[0]) : null;
  const action = pathParts[1];

  try {
    const sheets = await getSheetsClient();

    // GET /api/sheets — tüm sekme adları
    if (!sheetName && req.method === "GET") {
      const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
      const names = (meta.data.sheets || []).map((s) => s.properties?.title || "");
      return res.json({ sheets: names });
    }

    // GET /api/sheets/:sheet — veri oku
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

    // PUT /api/sheets/:sheet/cell — tek hücre güncelle
    if (sheetName && action === "cell" && req.method === "PUT") {
      const { row, col, value } = req.body;
      const colLetter = colToLetter(col + 1);
      const cellRef = `${sheetName}!${colLetter}${row}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: cellRef,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[value]] },
      });
      return res.json({ success: true });
    }

    // PUT /api/sheets/:sheet/row/:rowNum — tüm satır güncelle
    if (sheetName && action === "row" && pathParts[2] && req.method === "PUT") {
      const rowNum = parseInt(pathParts[2]);
      const { values } = req.body;
      const colCount = values.length;
      const cellRef = `${sheetName}!A${rowNum}:${colToLetter(colCount)}${rowNum}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: cellRef,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [values] },
      });
      return res.json({ success: true });
    }

    // POST /api/sheets/:sheet/row — yeni satır ekle
    if (sheetName && action === "row" && !pathParts[2] && req.method === "POST") {
      const { values } = req.body;
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: sheetName,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [values] },
      });
      return res.json({ success: true });
    }

    // DELETE /api/sheets/:sheet/row/:rowNum — satır sil
    if (sheetName && action === "row" && pathParts[2] && req.method === "DELETE") {
      const rowIndex = parseInt(pathParts[2]);
      const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
      const sheet = meta.data.sheets?.find((s) => s.properties?.title === sheetName);
      if (!sheet) return res.status(404).json({ error: "Sheet not found" });
      const sheetId = sheet.properties?.sheetId;
      // rowIndex zaten gerçek Sheets satır numarası (1-tabanlı, header dahil)
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: {
                sheetId,
                dimension: "ROWS",
                startIndex: rowIndex - 1,
                endIndex: rowIndex,
              },
            },
          }],
        },
      });
      return res.json({ success: true });
    }

    return res.status(404).json({ error: "Not found" });
  } catch (err) {
    console.error("Turne API Error:", err);
    return res.status(500).json({ error: err.message });
  }
};
