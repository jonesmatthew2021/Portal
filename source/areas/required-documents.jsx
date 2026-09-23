/* Required Documents For Upload — the Admin tab of that name.
 *
 * Spliced into source/index.html by the build, so there is no import or
 * export here: by the time it runs it is the same one file it always was.
 * The shell holds the theme, the shared components and the state; this
 * holds what is only this tab's. See tools/source.mjs.
 */
/**
 * Everything the portal has to be given, on one page.
 *
 * There are four of them: the three documents it keeps exactly one of apiece — the
 * training matrix, the skills matrix (which also carries the validity periods),
 * the crew certificates spreadsheet — and the crew's certificates themselves.
 * They used to sit on three different screens of the Certification Checker, which
 * meant an admin setting up a fresh portal had to find each one somewhere else and
 * could not see, from any one of them, what was still outstanding. They are filed
 * here now, first thing on the tab, and the screens that read them only read them.
 */
function RequiredDocuments() {
  const portal = usePortal();
  const { certSheet } = portal;
  const records = matrixRecords(portal);
  const setters = matrixSetters(portal);

  const docs = [
    ...MATRIX_CARDS.map((c) => ({
      key: c.key,
      title: c.title,
      noun: c.noun,
      blurb: c.blurb,
      required: c.required,
      record: records[c.key] || null,
      upload: (record) => {
        // The same landing whichever way the file arrives — uploaded from a
        // machine or pointed at in the library.
        const filed = (rec) => {
          setters[c.key](rec);
          // The skills matrix carries the validity periods, which feed the
          // crew matrix — they are what turns a certificate's issue date
          // into the expiry the matrix carries — so replacing it holds the
          // certificates against the new periods and brings the matrix up to
          // what they now say. The compliance check reads it afresh on its
          // own screen.
          if (c.key === "skills") portal.runMatrixAuto({ validityMatrix: rec, origin: "spreadsheet" });
        };
        return (
          <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
            <SingleDocumentUpload
              category={c.category}
              noun={c.noun}
              eyebrow={c.title}
              blurb={`${c.blurb} One is kept on the portal - the latest - ${
                c.required
                  ? "and it is required at all times, so uploading a newer one replaces it in the same step."
                  : "so uploading a newer one replaces it in the same step."}`}
              current={record}
              onFiled={filed}
              logAction={c.logAction}
              label={record ? `Replace the ${c.noun}` : `Upload the ${c.noun}`}
              variant={record ? "quiet" : "solid"}
            />
            <ImportFromSharePoint category={c.category} noun={c.noun} onFiled={filed} logAction={c.logAction} />
          </span>
        );
      },
    })),
    {
      key: "certificate-sheet",
      title: "OPMS spreadsheet",
      noun: "crew certificates spreadsheet",
      blurb: "This spread sheet is populated weekly from Portways and is the our crews records held by OPMS, call PK if you need it.",
      required: true,
      record: certSheet || null,
      upload: (record) => (
        <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
          <UpdateSpreadsheet
            label={record ? "Replace the spreadsheet" : "Upload the spreadsheet"}
            variant={record ? "quiet" : "solid"}
          />
          <ImportFromSharePoint category="certificate-sheet" noun="crew certificates spreadsheet"
            onFiled={(rec) => portal.setCertSheet(rec)}
            logAction="Filed the crew certificates spreadsheet from SharePoint" />
        </span>
      ),
    },
  ];


  return (
    <div>
      {/* Straight to the documents. The spreadsheet is brought up to date by
          Update portal at the top of every page, which does this and
          the rest of the round; Start again is at the foot of Access Grants,
          with the other things nobody should press in a hurry. Each card
          carries its own state, so a summary above them said it twice. */}
      <div className="um-reqdocs">
        {docs.map((d) => (
          <div key={d.key} style={{ background: T.panel, border: `1px solid ${T.rule}`,
            borderLeft: `4px solid ${d.record ? T.green : d.required ? T.bRed : T.bOrange}`, borderRadius: 2,
            padding: "13px 15px", minWidth: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <Eyebrow color={d.record ? T.accent : d.required ? T.bRed : T.bOrange}>{d.title}</Eyebrow>
              <Chip fg={d.record ? T.bGreen : d.required ? T.bRed : T.bOrange}
                bg={d.record ? T.bGreenBg : d.required ? T.bRedBg : T.bOrangeBg}>
                {d.record ? "on file" : d.required ? "required - not on file" : "not on file"}
              </Chip>
            </div>
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.muted, lineHeight: 1.6, marginTop: 8 }}>
              {d.blurb}
            </div>
            <div style={{ fontFamily: T.body, fontSize: 13.5, color: d.record ? T.text : d.required ? T.bRed : T.bOrange,
              marginTop: 10, wordBreak: "break-word" }}>
              {d.record
                ? d.record.filename
                : d.required
                ? `No ${d.noun} has been filed. The portal is required to hold one at all times.`
                : `No ${d.noun} has been filed. It is read with the skills matrix wherever one is.`}
            </div>
            {/* When the document was last updated, said in every box - a dash
                means nothing has ever been filed for it. */}
            <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, marginTop: 3 }}>
              Last updated: {d.record?.uploaded ? fmtDate(d.record.uploaded) : "—"}
              {d.record?.size ? ` · ${d.record.size}` : ""}
              {d.record?.by ? ` · ${d.record.by}` : ""}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
              {d.record && <OpenLink url={d.record.url} />}
              {d.upload(d.record)}
            </div>
          </div>
        ))}
      </div>

      <div style={{ height: 1, background: T.rule, margin: "22px 0" }} />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start",
        gap: 14, flexWrap: "wrap", marginBottom: 14 }}>
        <div style={{ flex: "1 1 320px" }}>
          <Eyebrow color={T.accent}>Crew certificates</Eyebrow>
        </div>
        <UpdateTableButton />
      </div>
      <UploadCertificates />
    </div>
  );
}
