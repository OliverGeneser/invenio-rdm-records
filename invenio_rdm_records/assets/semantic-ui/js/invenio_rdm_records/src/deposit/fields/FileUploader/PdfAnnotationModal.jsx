/*
 * SPDX-FileCopyrightText: 2026 CERN.
 * SPDX-License-Identifier: MIT
 */

import { i18next } from "@translations/invenio_rdm_records/i18next";
import PropTypes from "prop-types";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDispatch } from "react-redux";
import axios from "axios";
import {
  Button,
  Dimmer,
  Form,
  Grid,
  Header,
  Icon,
  Label,
  List,
  Loader,
  Message,
  Modal,
} from "semantic-ui-react";
import { updateFileMetadata } from "../../state/actions/files";

export const isPdfFile = (file) => {
  if (!file) return false;
  const mimetype = file.mimetype || "";
  const name = file.name || file.key || "";
  return mimetype === "application/pdf" || /\.pdfa?$/i.test(name);
};

const makeId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

const ANNOTATION_COLORS = ["#ffe900", "#a8ff9e", "#9ecbff", "#ffb09e", "#e3a8ff"];

const normalizeAnnotations = (metadata) => {
  const raw = metadata?.annotations;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a) => a && typeof a.page === "number")
    .map((a) => ({
      id: a.id || makeId(),
      page: a.page,
      x: Number(a.x) || 0,
      y: Number(a.y) || 0,
      width: Number(a.width) || 10,
      height: Number(a.height) || 5,
      type: a.type === "note" ? "note" : "highlight",
      color: a.color || ANNOTATION_COLORS[0],
      content: a.content || "",
      created: a.created || new Date().toISOString(),
    }));
};

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/**
 * Modal PDF viewer with highlight + note annotations persisted
 * to the draft file's metadata (`metadata.annotations`) via the
 * existing draft files API (PUT .../files/<key>).
 */
export const PdfAnnotationModal = ({ open, onClose, file }) => {
  const dispatch = useDispatch();
  const [numPages, setNumPages] = useState(0);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [annotations, setAnnotations] = useState(() =>
    normalizeAnnotations(file?.metadata)
  );
  const [tool, setTool] = useState("highlight");
  const [color, setColor] = useState(ANNOTATION_COLORS[0]);
  const [draftRect, setDraftRect] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [savedTick, setSavedTick] = useState(null);
  const [scale, setScale] = useState(1.5);
  const pageRefs = useRef({});
  const dragState = useRef(null);

  // Reset when a different file is opened.
  useEffect(() => {
    if (open) {
      setAnnotations(normalizeAnnotations(file?.metadata));
      setSelectedId(null);
      setNoteDraft("");
      setDraftRect(null);
      setSaveError(null);
      setLoadError(null);
      setPdfDoc(null);
      setNumPages(0);
    }
    // file.metadata intentionally excluded: resetting on every metadata object
    // identity change would wipe unsaved edits (e.g. after a Redux refresh).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, file?.name]);

  const contentUrl = file?.links?.content;
  const selfLink = file?.links?.self;

  const loadPdf = useCallback(async () => {
    if (!open || !contentUrl) return;
    setLoading(true);
    setLoadError(null);
    try {
      // NOTE: do NOT send `Accept: application/pdf` here. The file content
      // endpoint negotiates the response handler from the Accept header and
      // returns 406 for non-JSON accepts. A plain GET (Accept: */*) returns
      // the raw bytes.
      const response = await axios.get(contentUrl, {
        responseType: "arraybuffer",
        withCredentials: true,
      });
      // Dynamic import so jest / builds without pdfjs still render the shell.
      let pdfjsLib;
      try {
        pdfjsLib = await import("pdfjs-dist");
      } catch (importError) {
        console.error("Could not import pdfjs-dist", importError);
        throw new Error(
          `PDF viewer library failed to load: ${importError?.message || importError}`
        );
      }
      // Handle both ESM (`{ getDocument }`) and CJS (`{ default: {...} }`) shapes.
      const pdfjs = pdfjsLib?.default?.getDocument ? pdfjsLib.default : pdfjsLib;
      if (!pdfjs?.getDocument) {
        throw new Error("PDF viewer library is missing getDocument().");
      }
      try {
        if (pdfjs?.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) {
          // Reuse the worker shipped by invenio-previewer when available,
          // fallback to a CDN copy of the same major line.
          pdfjs.GlobalWorkerOptions.workerSrc =
            "/static/js/pdfjs/build/pdf.worker.min.mjs";
        }
      } catch (workerError) {
        console.warn("Could not set pdf.js workerSrc", workerError);
      }
      let doc;
      try {
        const loadingTask = pdfjs.getDocument({ data: response.data });
        doc = await loadingTask.promise;
      } catch (pdfError) {
        // Worker misconfiguration is the most common cause here (404 on the
        // worker URL). Retry once with a CDN worker before giving up.
        console.warn("pdf.js getDocument failed, retrying with CDN worker", pdfError);
        try {
          if (pdfjs?.GlobalWorkerOptions) {
            pdfjs.GlobalWorkerOptions.workerSrc =
              "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.54/pdf.worker.min.mjs";
          }
          const retryTask = pdfjs.getDocument({ data: response.data });
          doc = await retryTask.promise;
        } catch (retryError) {
          console.error("pdf.js retry failed", retryError);
          throw pdfError;
        }
      }
      setPdfDoc(doc);
      setNumPages(doc.numPages);
    } catch (e) {
      console.error("Could not load PDF for annotation", e);
      const status = e?.response?.status;
      if (status === 404) {
        setLoadError(
          i18next.t("PDF content is not available yet. Finish the upload first.")
        );
      } else {
        const base = i18next.t("Could not load the PDF. You can still download it.");
        const detail = e?.message ? ` (${e.message})` : "";
        setLoadError(`${base}${detail}`);
      }
    } finally {
      setLoading(false);
    }
  }, [open, contentUrl]);

  useEffect(() => {
    if (open) {
      loadPdf();
    } else {
      // Cleanup rendered pages when closed.
      pageRefs.current = {};
    }
  }, [open, loadPdf]);

  // Render pages to canvas when doc/scale changes.
  useEffect(() => {
    if (!pdfDoc) return;
    let cancelled = false;
    const renderAll = async () => {
      for (let n = 1; n <= pdfDoc.numPages; n++) {
        if (cancelled) return;
        try {
          const page = await pdfDoc.getPage(n);
          const viewport = page.getViewport({ scale });
          const canvas = pageRefs.current[`canvas-${n}`];
          if (!canvas) continue;
          const context = canvas.getContext("2d");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width = "100%";
          canvas.style.height = "auto";
          await page.render({ canvasContext: context, viewport }).promise;
          const wrapper = pageRefs.current[`wrap-${n}`];
          if (wrapper) {
            wrapper.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
          }
        } catch (e) {
          console.error(`Could not render PDF page ${n}`, e);
        }
      }
    };
    renderAll();
    return () => {
      cancelled = true;
    };
  }, [pdfDoc, scale, numPages]);

  const startDrag = (e, page) => {
    if (tool !== "highlight") return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    dragState.current = { page, startX: x, startY: y };
    setDraftRect({ page, x, y, width: 0, height: 0 });
  };

  const moveDrag = (e) => {
    const drag = dragState.current;
    if (!drag || !draftRect) return;
    const wrap = pageRefs.current[`wrap-${drag.page}`];
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setDraftRect({
      page: drag.page,
      x: Math.min(drag.startX, x),
      y: Math.min(drag.startY, y),
      width: Math.abs(x - drag.startX),
      height: Math.abs(y - drag.startY),
    });
  };

  const endDrag = () => {
    const rect = draftRect;
    dragState.current = null;
    if (!rect) return;
    if (rect.width < 1 || rect.height < 0.5) {
      setDraftRect(null);
      return;
    }
    const annotation = {
      id: makeId(),
      page: rect.page,
      x: clamp(rect.x, 0, 100),
      y: clamp(rect.y, 0, 100),
      width: clamp(rect.width, 0.5, 100),
      height: clamp(rect.height, 0.5, 100),
      type: "highlight",
      color,
      content: "",
      created: new Date().toISOString(),
    };
    setAnnotations((prev) => [...prev, annotation]);
    setSelectedId(annotation.id);
    setNoteDraft("");
    setDraftRect(null);
  };

  const addNotePin = (e, page) => {
    if (tool !== "note") return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    const annotation = {
      id: makeId(),
      page,
      x: clamp(x - 1.5, 0, 97),
      y: clamp(y - 1.5, 0, 97),
      width: 3,
      height: 3,
      type: "note",
      color,
      content: "",
      created: new Date().toISOString(),
    };
    setAnnotations((prev) => [...prev, annotation]);
    setSelectedId(annotation.id);
    setNoteDraft("");
  };

  const selected = annotations.find((a) => a.id === selectedId) || null;

  useEffect(() => {
    setNoteDraft(selected?.content || "");
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateSelectedNote = (value) => {
    setNoteDraft(value);
    if (!selected) return;
    setAnnotations((prev) =>
      prev.map((a) => (a.id === selected.id ? { ...a, content: value } : a))
    );
  };

  const deleteAnnotation = (id) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    if (selectedId === id) {
      setSelectedId(null);
    }
  };

  const handleSave = async () => {
    if (!selfLink) {
      setSaveError(i18next.t("File link is missing, cannot save."));
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const existingMetadata = file?.metadata || {};
      const nextMetadata = { ...existingMetadata, annotations };
      await dispatch(updateFileMetadata(file, nextMetadata));
      setSavedTick(new Date().toISOString());
    } catch (e) {
      console.error("Could not save PDF annotations", e);
      setSaveError(i18next.t("Could not save annotations. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    JSON.stringify(normalizeAnnotations(file?.metadata)) !==
    JSON.stringify(annotations);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="fullscreen"
      closeIcon
      className="pdf-annotation-modal"
    >
      <Modal.Header>
        <Icon name="pencil alternate" />{" "}
        {i18next.t("Annotate {{filename}}", { filename: file?.name || "" })}
      </Modal.Header>
      <Modal.Content scrolling>
        <Grid stackable>
          <Grid.Row>
            <Grid.Column width={11}>
              <Button.Group size="small">
                <Button
                  type="button"
                  active={tool === "highlight"}
                  onClick={() => setTool("highlight")}
                  icon="paint brush"
                  content={i18next.t("Highlight")}
                />
                <Button
                  type="button"
                  active={tool === "note"}
                  onClick={() => setTool("note")}
                  icon="sticky note outline"
                  content={i18next.t("Note")}
                />
              </Button.Group>{" "}
              {ANNOTATION_COLORS.map((c) => (
                <Button
                  key={c}
                  type="button"
                  circular
                  size="mini"
                  active={color === c}
                  onClick={() => setColor(c)}
                  style={{
                    backgroundColor: c,
                    border: color === c ? "2px solid black" : "1px solid #ccc",
                    width: "2em",
                    height: "2em",
                    padding: 0,
                    marginLeft: "0.25em",
                  }}
                  aria-label={i18next.t("Annotation color")}
                />
              ))}{" "}
              <Button.Group size="small" style={{ marginLeft: "1em" }}>
                <Button
                  type="button"
                  icon="zoom out"
                  onClick={() =>
                    setScale((s) => Math.max(0.75, +(s - 0.25).toFixed(2)))
                  }
                />
                <Button type="button" disabled>
                  {Math.round(scale * 100)}%
                </Button>
                <Button
                  type="button"
                  icon="zoom in"
                  onClick={() => setScale((s) => Math.min(3, +(s + 0.25).toFixed(2)))}
                />
              </Button.Group>
              <div style={{ marginTop: "0.5em" }} className="ui text-muted">
                {tool === "highlight"
                  ? i18next.t("Drag a rectangle over the PDF to highlight it.")
                  : i18next.t("Click anywhere on a page to drop a note.")}
              </div>
              <Dimmer.Dimmable dimmed={loading} style={{ marginTop: "1em" }}>
                <Dimmer active={loading} inverted>
                  <Loader>{i18next.t("Loading PDF…")}</Loader>
                </Dimmer>
                {loadError && (
                  <Message warning>
                    <p>{loadError}</p>
                    {contentUrl && (
                      <Button
                        as="a"
                        href={contentUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        size="small"
                        primary
                      >
                        <Icon name="download" /> {i18next.t("Download PDF")}
                      </Button>
                    )}
                  </Message>
                )}
                {!pdfDoc && !loading && !loadError && (
                  <Message info>{i18next.t("No PDF loaded yet.")}</Message>
                )}
                {Array.from({ length: numPages }, (_, i) => i + 1).map((page) => (
                  <div
                    key={page}
                    role="button"
                    tabIndex={0}
                    aria-label={i18next.t(
                      "PDF page {{page}}. Press Enter to add a note.",
                      {
                        page,
                      }
                    )}
                    ref={(el) => {
                      if (el) pageRefs.current[`wrap-${page}`] = el;
                    }}
                    onMouseDown={(e) => startDrag(e, page)}
                    onMouseMove={moveDrag}
                    onMouseUp={endDrag}
                    onMouseLeave={endDrag}
                    onClick={(e) => {
                      // Note pins are click-based; highlight uses drag.
                      if (tool === "note") addNotePin(e, page);
                    }}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === " ") && tool === "note") {
                        e.preventDefault();
                        const wrap = pageRefs.current[`wrap-${page}`];
                        if (!wrap) return;
                        const rect = wrap.getBoundingClientRect();
                        const fakeEvent = {
                          currentTarget: wrap,
                          clientX: rect.left + rect.width / 2,
                          clientY: rect.top + rect.height / 2,
                        };
                        addNotePin(fakeEvent, page);
                      }
                    }}
                    style={{
                      position: "relative",
                      width: "100%",
                      margin: "1em 0",
                      border: "1px solid #ddd",
                      background: "#f9f9f9",
                      cursor: tool === "highlight" ? "crosshair" : "copy",
                      userSelect: "none",
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        top: 4,
                        left: 8,
                        zIndex: 5,
                        background: "rgba(0,0,0,0.6)",
                        color: "#fff",
                        fontSize: 11,
                        padding: "1px 6px",
                        borderRadius: 3,
                      }}
                    >
                      {i18next.t("Page {{page}}", { page })}
                    </div>
                    <canvas
                      ref={(el) => {
                        if (el) pageRefs.current[`canvas-${page}`] = el;
                      }}
                      style={{ display: "block", width: "100%" }}
                    />
                    {/* existing annotations */}
                    {annotations
                      .filter((a) => a.page === page)
                      .map((a) =>
                        a.type === "note" ? (
                          <div
                            key={a.id}
                            role="button"
                            tabIndex={0}
                            aria-label={a.content || i18next.t("Note")}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedId(a.id);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                e.stopPropagation();
                                setSelectedId(a.id);
                              }
                            }}
                            title={a.content || i18next.t("Note")}
                            style={{
                              position: "absolute",
                              left: `${a.x}%`,
                              top: `${a.y}%`,
                              width: "22px",
                              height: "22px",
                              borderRadius: "50%",
                              background: a.color,
                              border:
                                selectedId === a.id
                                  ? "2px solid black"
                                  : "1px solid rgba(0,0,0,0.5)",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              cursor: "pointer",
                              zIndex: 4,
                            }}
                          >
                            <Icon
                              name="sticky note"
                              fitted
                              size="small"
                              style={{ margin: 0 }}
                            />
                          </div>
                        ) : (
                          <div
                            key={a.id}
                            role="button"
                            tabIndex={0}
                            aria-label={a.content || i18next.t("Highlight")}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedId(a.id);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                e.stopPropagation();
                                setSelectedId(a.id);
                              }
                            }}
                            title={a.content || i18next.t("Highlight")}
                            style={{
                              position: "absolute",
                              left: `${a.x}%`,
                              top: `${a.y}%`,
                              width: `${a.width}%`,
                              height: `${a.height}%`,
                              background: a.color,
                              opacity: selectedId === a.id ? 0.65 : 0.45,
                              border:
                                selectedId === a.id
                                  ? "1px solid black"
                                  : "1px solid rgba(0,0,0,0.15)",
                              cursor: "pointer",
                              zIndex: 3,
                            }}
                          />
                        )
                      )}
                    {/* in-progress rectangle */}
                    {draftRect && draftRect.page === page && (
                      <div
                        style={{
                          position: "absolute",
                          left: `${draftRect.x}%`,
                          top: `${draftRect.y}%`,
                          width: `${draftRect.width}%`,
                          height: `${draftRect.height}%`,
                          background: color,
                          opacity: 0.5,
                          border: "1px dashed black",
                          zIndex: 6,
                          pointerEvents: "none",
                        }}
                      />
                    )}
                  </div>
                ))}
              </Dimmer.Dimmable>
            </Grid.Column>
            <Grid.Column width={5}>
              <Header as="h4">
                {i18next.t("Annotations ({{count}})", { count: annotations.length })}
              </Header>
              {selected ? (
                <Form>
                  <Form.TextArea
                    label={i18next.t("Note for {{type}} on page {{page}}", {
                      type:
                        selected.type === "note"
                          ? i18next.t("note")
                          : i18next.t("highlight"),
                      page: selected.page,
                    })}
                    value={noteDraft}
                    onChange={(e, { value }) => updateSelectedNote(value)}
                    placeholder={i18next.t("Write a comment for this annotation…")}
                    rows={4}
                  />
                  <Button
                    type="button"
                    size="small"
                    negative
                    basic
                    icon="trash"
                    content={i18next.t("Delete")}
                    onClick={() => deleteAnnotation(selected.id)}
                  />{" "}
                  <Button
                    type="button"
                    size="small"
                    basic
                    content={i18next.t("Deselect")}
                    onClick={() => setSelectedId(null)}
                  />
                </Form>
              ) : (
                <p className="ui text-muted">
                  {i18next.t("Select a highlight or note to add a comment.")}
                </p>
              )}
              <List divided relaxed style={{ marginTop: "1em" }}>
                {annotations.map((a) => (
                  <List.Item
                    key={a.id}
                    active={a.id === selectedId}
                    onClick={() => setSelectedId(a.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <List.Icon
                      name={a.type === "note" ? "sticky note outline" : "paint brush"}
                      verticalAlign="middle"
                    />
                    <List.Content>
                      <List.Header>
                        {a.type === "note" ? i18next.t("Note") : i18next.t("Highlight")}{" "}
                        · {i18next.t("page {{page}}", { page: a.page })}
                        <Button
                          type="button"
                          icon="trash alternate outline"
                          size="mini"
                          basic
                          floated="right"
                          aria-label={i18next.t("Delete annotation")}
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteAnnotation(a.id);
                          }}
                        />
                      </List.Header>
                      <List.Description
                        style={{
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {a.content || (
                          <span className="ui text-muted">
                            {i18next.t("No comment yet")}
                          </span>
                        )}
                      </List.Description>
                    </List.Content>
                  </List.Item>
                ))}
              </List>
              {annotations.length === 0 && (
                <Message info size="small">
                  {i18next.t("No annotations yet. Use the Highlight or Note tool.")}
                </Message>
              )}
              {saveError && (
                <Message negative size="small">
                  {saveError}
                </Message>
              )}
              {savedTick && !dirty && (
                <Label color="green" size="small" style={{ marginTop: "0.5em" }}>
                  <Icon name="check" /> {i18next.t("Saved to backend")}
                </Label>
              )}
              {dirty && (
                <Label color="yellow" size="small" style={{ marginTop: "0.5em" }}>
                  {i18next.t("Unsaved changes")}
                </Label>
              )}
            </Grid.Column>
          </Grid.Row>
        </Grid>
      </Modal.Content>
      <Modal.Actions>
        {contentUrl && (
          <Button
            as="a"
            href={contentUrl}
            target="_blank"
            rel="noopener noreferrer"
            type="button"
            basic
            floated="left"
          >
            <Icon name="external alternate" /> {i18next.t("Open original")}
          </Button>
        )}
        <Button type="button" onClick={onClose}>
          {i18next.t("Close")}
        </Button>
        <Button
          type="button"
          primary
          loading={saving}
          disabled={saving}
          onClick={handleSave}
        >
          <Icon name="save" /> {i18next.t("Save annotations")}
        </Button>
      </Modal.Actions>
    </Modal>
  );
};

PdfAnnotationModal.propTypes = {
  open: PropTypes.bool,
  onClose: PropTypes.func,
  file: PropTypes.shape({
    name: PropTypes.string,
    mimetype: PropTypes.string,
    metadata: PropTypes.object,
    links: PropTypes.object,
  }),
};

PdfAnnotationModal.defaultProps = {
  open: false,
  onClose: () => {},
  file: undefined,
};

export default PdfAnnotationModal;
