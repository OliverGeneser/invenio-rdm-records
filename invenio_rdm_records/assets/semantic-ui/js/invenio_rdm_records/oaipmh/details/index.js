/*
 * SPDX-FileCopyrightText: 2022 CERN.
 * SPDX-License-Identifier: MIT
 */

import { createRoot } from "react-dom/client";
import _get from "lodash/get";
import { OverridableContext, parametrize } from "react-overridable";
import LinksTable from "./LinksTable";
import { AdminDetailsView, Edit, Delete } from "@js/invenio_administration";
import { i18next } from "@translations/invenio_rdm_records/i18next";

const domContainer = document.getElementById("invenio-details-config");
const title = domContainer.dataset.title;
const fields = JSON.parse(domContainer.dataset.fields);
const pidValue = JSON.parse(domContainer.dataset.pid);
const resourceName = JSON.parse(domContainer.dataset.resourceName);
const displayEdit = JSON.parse(domContainer.dataset.displayEdit);
const displayDelete = JSON.parse(domContainer.dataset.displayDelete);
const actions = JSON.parse(domContainer.dataset.actions);
const apiEndpoint = _get(domContainer.dataset, "apiEndpoint");
const idKeyPath = JSON.parse(_get(domContainer.dataset, "pidPath", "pid"));
const listUIEndpoint = domContainer.dataset.listEndpoint;
const resourceSchema = JSON.parse(domContainer.dataset.resourceSchema);
const uiSchema = JSON.parse(domContainer.dataset.uiConfig);

const createdBySystem = (data) => data?.system_created;

const overridenComponents = {
  "InvenioAdministration.EditAction": parametrize(Edit, {
    disable: createdBySystem,
    disabledMessage: i18next.t(
      "This set is not editable as it was created by the system."
    ),
  }),
  "InvenioAdministration.DeleteAction": parametrize(Delete, {
    disable: createdBySystem,
    disabledMessage: i18next.t(
      "This set is not deletable as it was created by the system."
    ),
  }),
};

domContainer &&
  (() => {
    // See invenio_administration details.js: share a single root per
    // container so the page-specific bundle updates (rather than fights)
    // the generic details bundle. Last render wins.
    if (!domContainer._invenioReactRoot) {
      domContainer._invenioReactRoot = createRoot(domContainer);
    }
    domContainer._invenioReactRoot.render(
      <OverridableContext.Provider value={overridenComponents}>
        <AdminDetailsView
          title={title}
          actions={actions}
          apiEndpoint={apiEndpoint}
          columns={fields}
          displayEdit={displayEdit}
          displayDelete={displayDelete}
          pid={pidValue}
          idKeyPath={idKeyPath}
          resourceName={resourceName}
          listUIEndpoint={listUIEndpoint}
          resourceSchema={resourceSchema}
          uiSchema={uiSchema}
        >
          <LinksTable />
        </AdminDetailsView>
      </OverridableContext.Provider>
    );
  })();
