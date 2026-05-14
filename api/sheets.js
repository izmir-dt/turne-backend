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
      const valueInputOption = sheetName === "FIRMA_REHBERI" ? "RAW" : "USER_ENTERED";
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: cellRef,
        valueInputOption,
        requestBody: { values: [values] },
      });
      return res.json({ success: true });
    }

    // POST /api/sheets/:sheet/row — yeni satır ekle
    // insertAfterRow varsa o satırdan sonra ekle, yoksa en alta ekle
    if (sheetName && action === "row" && !pathParts[2] && req.method === "POST") {
      const { values, insertAfterRow } = req.body;

      if (insertAfterRow && typeof insertAfterRow === "number") {
        // Sheet ID bul
        const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const sheet = meta.data.sheets?.find((s) => s.properties?.title === sheetName);
        if (!sheet) return res.status(404).json({ error: "Sheet not found" });
        const sheetId = sheet.properties?.sheetId;
        const currentRowCount = sheet.properties?.gridProperties?.rowCount ?? 0;

        // Sheet doluysa önce kapasite ekle
        if (currentRowCount <= insertAfterRow) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            requestBody: {
              requests: [{ appendDimension: { sheetId, dimension: "ROWS", length: 10 } }],
            },
          });
        }

        // insertAfterRow satırından sonraya boş satır ekle (0-tabanlı)
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: {
            requests: [{
              insertDimension: {
                range: {
                  sheetId,
                  dimension: "ROWS",
                  startIndex: insertAfterRow,
                  endIndex: insertAfterRow + 1,
                },
                inheritFromBefore: true,
              },
            }],
          },
        });

        // Eklenen satıra veriyi yaz
        const newRowNum = insertAfterRow + 1;
        const colLetter = colToLetter(values.length);
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `${sheetName}!A${newRowNum}:${colLetter}${newRowNum}`,
          valueInputOption: sheetName === "FIRMA_REHBERI" ? "RAW" : "USER_ENTERED",
          requestBody: { values: [values] },
        });

        return res.json({ success: true, rowNumber: newRowNum });
      }

      // insertAfterRow yoksa: sheet meta bilgisini al, gerekirse satır ekle, sonra yaz
      // update() sheet sınırı dışına yazamaz — önce appendDimension ile satır açıyoruz
      const metaForAppend = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
      const sheetMeta = metaForAppend.data.sheets?.find((s) => s.properties?.title === sheetName);
      if (!sheetMeta) return res.status(404).json({ error: "Sheet not found" });
      const sheetIdForAppend = sheetMeta.properties?.sheetId;
      const currentRowCount = sheetMeta.properties?.gridProperties?.rowCount ?? 0;

      const existingRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: sheetName,
      });
      const existingRows = existingRes.data.values || [];
      const nextRow = existingRows.length + 1; // header + data + 1

      // Eğer yeni satır sheet sınırının dışındaysa önce satır ekle
      if (nextRow > currentRowCount) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: {
            requests: [{
              appendDimension: {
                sheetId: sheetIdForAppend,
                dimension: "ROWS",
                length: Math.max(nextRow - currentRowCount, 10), // en az 10 satır ekle
              },
            }],
          },
        });
      }

      const colLetter = colToLetter(values.length);
      const rangeToWrite = `${sheetName}!A${nextRow}:${colLetter}${nextRow}`;

      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: rangeToWrite,
        valueInputOption: sheetName === "FIRMA_REHBERI" ? "RAW" : "USER_ENTERED",
        requestBody: { values: [values] },
      });

      return res.json({ success: true, rowNumber: nextRow });
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

    // PUT /api/sheets/:sheet/batch — çoklu satır tek seferde güncelle
    // body: { updates: [{ row, values }], inserts: [{ values }] }
    if (sheetName && action === "batch" && req.method === "PUT") {
      const { updates = [], inserts = [] } = req.body;

      const batchData = [];

      // Güncellenecek satırlar
      for (const item of updates) {
        const { row, values } = item;
        if (!row || !values) continue;
        const colLetter = colToLetter(values.length);
        batchData.push({
          range: `${sheetName}!A${row}:${colLetter}${row}`,
          values: [values],
        });
      }

      if (batchData.length > 0) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: {
            valueInputOption: sheetName === "FIRMA_REHBERI" ? "RAW" : "USER_ENTERED",
            data: batchData,
          },
        });
      }

      // Yeni satır eklemeler (sırayla, ama tek tek yerine batched GET sonrası)
      const insertResults = [];
      if (inserts.length > 0) {
        const existingRes = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: sheetName,
        });
        const existingRows = existingRes.data.values || [];
        let nextRow = existingRows.length + 1;

        const metaRes = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const sheetMeta = metaRes.data.sheets?.find((s) => s.properties?.title === sheetName);
        const sheetId = sheetMeta?.properties?.sheetId;
        const currentRowCount = sheetMeta?.properties?.gridProperties?.rowCount ?? 0;

        const totalNeeded = nextRow + inserts.length - 1;
        if (totalNeeded > currentRowCount) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            requestBody: {
              requests: [{
                appendDimension: {
                  sheetId,
                  dimension: "ROWS",
                  length: Math.max(totalNeeded - currentRowCount + 10, 20),
                },
              }],
            },
          });
        }

        // Tüm insert'leri tek batchUpdate ile yaz
        const insertBatch = inserts.map((item, idx) => ({
          range: `${sheetName}!A${nextRow + idx}:${colToLetter(item.values.length)}${nextRow + idx}`,
          values: [item.values],
        }));

        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: {
            valueInputOption: sheetName === "FIRMA_REHBERI" ? "RAW" : "USER_ENTERED",
            data: insertBatch,
          },
        });

        inserts.forEach((_, idx) => insertResults.push({ rowNumber: nextRow + idx }));
      }

      return res.json({ success: true, insertResults });
    }

    return res.status(404).json({ error: "Not found" });
  } catch (err) {
    console.error("Turne API Error:", err);
    return res.status(500).json({ error: err.message });
  }
};
