/*
 * SPDX-FileCopyrightText: 2026 CERN.
 * SPDX-License-Identifier: MIT
 */

import { isPdfFile } from "./PdfAnnotationModal";
import fileReducer, { UploadState } from "../../state/reducers/files";
import { FILE_METADATA_UPDATE_SUCCESS } from "../../state/types";

describe("isPdfFile", () => {
  it("detects PDFs by mimetype", () => {
    expect(isPdfFile({ name: "paper.pdf", mimetype: "application/pdf" })).toBe(true);
  });
  it("detects PDFs by extension", () => {
    expect(isPdfFile({ name: "paper.PDF", mimetype: "" })).toBe(true);
    expect(isPdfFile({ name: "paper.pdfa", mimetype: "" })).toBe(true);
  });
  it("rejects non-PDFs", () => {
    expect(isPdfFile({ name: "data.zip", mimetype: "application/zip" })).toBe(false);
    expect(isPdfFile(null)).toBe(false);
  });
});

describe("files reducer annotation metadata", () => {
  it("stores metadata on FILE_METADATA_UPDATE_SUCCESS", () => {
    const state = {
      entries: {
        "paper.pdf": {
          name: "paper.pdf",
          status: UploadState.completed,
          metadata: {},
        },
      },
    };
    const annotations = [{ id: "a1", page: 1, x: 10, y: 10, width: 20, height: 5 }];
    const next = fileReducer(state, {
      type: FILE_METADATA_UPDATE_SUCCESS,
      payload: { filename: "paper.pdf", metadata: { annotations } },
    });
    expect(next.entries["paper.pdf"].metadata.annotations).toEqual(annotations);
  });
});
