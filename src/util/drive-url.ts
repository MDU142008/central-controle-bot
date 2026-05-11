// Acepta: un fileId crudo, o una URL de Google Docs/Sheets/Drive de la que extraer el id.
// Un fileId de Google es ~25-60 chars de [A-Za-z0-9_-]; aceptamos 20-80 por margen.

const FILE_ID_RE = /^[A-Za-z0-9_-]{20,80}$/;

export function extrairFileIdDeArg(arg: string): string | null {
  const s = arg.trim();
  if (!s) return null;
  if (FILE_ID_RE.test(s)) return s;
  // .../d/<id>/...   (docs.google.com/document/d/<id>/edit, /spreadsheets/d/<id>/...)
  const mD = s.match(/\/d\/([A-Za-z0-9_-]{20,80})/);
  if (mD) return mD[1]!;
  // ...?id=<id>  o  &id=<id>   (drive.google.com/open?id=<id>, /uc?id=<id>)
  const mId = s.match(/[?&]id=([A-Za-z0-9_-]{20,80})/);
  if (mId) return mId[1]!;
  // .../folders/<id>   (drive.google.com/drive/folders/<id>)
  const mF = s.match(/\/folders\/([A-Za-z0-9_-]{20,80})/);
  if (mF) return mF[1]!;
  return null;
}
