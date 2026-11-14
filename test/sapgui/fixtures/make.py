"""Builds the synthetic SAP GUI world the sapgui tests run on.

    python3 test/sapgui/fixtures/make.py

Writes world.json: a made-up SAP GUI (one connection, a few sessions, each on
one kind of screen), as the object tree SAP GUI scripting would expose. No
data from a real system. The fake SAP GUI for Windows tests
(test/sapgui/fake-sapgui.wsc) serves this file through COM.

The other fixtures are made from world.json, not by this script:

- facts/<session>.json is what the PowerShell host (src/sapgui/ps/) answers
  for each session of this world, captured on Windows through the fake SAP
  GUI;
- expected/<session>.txt is the full text view of each session, which
  format.test.ts holds the formatter to.

See test/sapgui/README.md for how to renew them.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent

PREFIX = {"GuiTextField": "txt", "GuiCTextField": "ctxt", "GuiPasswordField": "pwd", "GuiLabel": "lbl",
          "GuiCheckBox": "chk", "GuiRadioButton": "rad", "GuiComboBox": "cmb", "GuiButton": "btn", "GuiTab": "tabp",
          "GuiTabStrip": "tabs", "GuiBox": "box", "GuiTableControl": "tbl", "GuiSimpleContainer": "sub",
          "GuiScrollContainer": "ssub", "GuiCustomControl": "cntl"}


def N(seg: str, typ: str, *kids, **props) -> dict:
    return {"seg": seg, "Type": typ, **props, "kids": list(kids)}


def chrome(title: str, *usr, app=(), status=("", ""), menus=("Menu", "Edit", "Goto", "System", "Help"), extra=()) -> dict:
    """A main window with SAP GUI's usual frame around a user area."""
    return N("wnd[0]", "GuiMainWindow",
             N("mbar", "GuiMenubar", *[
                 N(f"menu[{i}]", "GuiMenu", *(
                     [N("menu[0]", "GuiMenu", Text="Create"), N("menu[1]", "GuiMenu", Text="Save"), N("menu[2]", "GuiMenu", Text="Exit")] if i == 0 else []),
                   Text=m) for i, m in enumerate(menus)]),
             N("tbar[0]", "GuiToolbar",
               N("okcd", "GuiOkCodeField", Text=""),
               N("btn[0]", "GuiButton", Text="", Tooltip="Enter   (Enter)", Changeable=True),
               N("btn[11]", "GuiButton", Text="", Tooltip="Save   (Ctrl+S)", Changeable=True),
               N("btn[3]", "GuiButton", Text="", Tooltip="Back   (F3)", Changeable=True),
               N("btn[15]", "GuiButton", Text="", Tooltip="Exit   (Shift+F3)", Changeable=True),
               N("btn[12]", "GuiButton", Text="", Tooltip="Cancel   (F12)", Changeable=True)),
             N("titl", "GuiTitlebar", Text=title),
             N("tbar[1]", "GuiToolbar", *app),
             N("usr", "GuiUserArea", *usr),
             *extra,
             N("sbar", "GuiStatusbar", N("pane[0]", "GuiStatusPane", Text=status[1]), Text=status[1], MessageType=status[0]),
             Text=title)


def popup(n: int, title: str, *usr, buttons=()) -> dict:
    return N(f"wnd[{n}]", "GuiModalWindow",
             N("tbar[0]", "GuiToolbar", *buttons),
             N("usr", "GuiUserArea", *usr),
             Text=title)


VA01 = chrome(
    "Create Sales Order: Initial Screen",
    N("lblVBAK-AUART", "GuiLabel", Text="Order Type"),
    N("ctxtVBAK-AUART", "GuiCTextField", Text="OR", Tooltip="Sales Document Type", Changeable=True, label="Order Type"),
    N("txtTVAKT-BEZEI", "GuiTextField", Text="Standard Order", Changeable=False),
    N("boxORG", "GuiBox", Text="Organizational Data"),
    N("lblVBAK-VKORG", "GuiLabel", Text="Sales Organization"),
    N("ctxtVBAK-VKORG", "GuiCTextField", Text="", Tooltip="Sales Organization", Changeable=True, label="Sales Organization"),
    N("ctxtVBAK-VTWEG", "GuiCTextField", Text="", Tooltip="Distribution Channel", Changeable=True),
    N("pwdDEMO-SECRET", "GuiPasswordField", Text="********", Tooltip="Secret", Changeable=True, label="Secret"),
    app=[N("btn[8]", "GuiButton", Text="Create with Reference", Tooltip="Create with Reference   (F8)", Changeable=True),
         N("btn[5]", "GuiButton", Text="Sales", Tooltip="Sales", Changeable=True)],
)

CELLS = []
for r, (item, mat, qty) in enumerate([("10", "M-01", "5"), ("20", "M-02", "1"), ("", "", "")]):
    CELLS += [
        N(f"txtVBAP-POSNR[0,{r}]", "GuiTextField", Text=item, Changeable=False),
        N(f"ctxtRV45A-MABNR[1,{r}]", "GuiCTextField", Text=mat, Changeable=False),
        N(f"txtRV45A-KWMENG[2,{r}]", "GuiTextField", Text=qty, Changeable=False),
        N(f"chkVBAP-ABGRU[3,{r}]", "GuiCheckBox", Text="", Tooltip="Rejected", Selected=(r == 1), Changeable=False),
    ]

VA03 = chrome(
    "Display Standard Order 4711: Overview",
    N("subSUBSCREEN_HEADER:SAPMV45A:4021", "GuiSimpleContainer",
      N("txtVBAK-VBELN", "GuiTextField", Text="4711", Changeable=False, label="Standard Order"),
      N("btnBT_HEAD", "GuiButton", Text="", Tooltip="Display document header details", Changeable=True)),
    N("tabsTAXI_TABSTRIP_OVERVIEW", "GuiTabStrip",
      N("tabpT\\01", "GuiTab",
        N("ssubSUBSCREEN_BODY:SAPMV45A:4400", "GuiScrollContainer",
          N("chkVBAK-AUTLF", "GuiCheckBox", Text="Complete dlv.", Selected=True, Changeable=False),
          N("radRV45A-DEMO1", "GuiRadioButton", Text="Gross", Selected=False, Changeable=False),
          N("radRV45A-DEMO2", "GuiRadioButton", Text="Net", Selected=True, Changeable=False),
          N("cmbVBAK-LIFSK", "GuiComboBox", Text="No block", Key=" ", Changeable=True, label="Delivery block",
            Entries=[[" ", "No block"], ["01", "Credit limit"], ["02", "Political reasons"]]),
          N("tblSAPMV45ATCTRL_U_ERF_AUFTRAG", "GuiTableControl", *CELLS, RowCount=3, VisibleRowCount=3,
            Columns=["Item", "Material", "Order Quantity", "Rej"])),
        Text="Sales"),
      N("tabpT\\02", "GuiTab", Text="Item overview"),
      N("tabpT\\03", "GuiTab", Text="Ordering party")),
    status=("S", "Standard Order 4711 is displayed"),
)

TREE = {
    "columns": None,
    "nodes": [
        {"key": "          1", "parent": "", "text": "Header texts", "folder": True, "expanded": True},
        {"key": "          2", "parent": "          1", "text": "Form Header", "folder": False},
        {"key": "          3", "parent": "          1", "text": "Shipping instructions", "folder": False},
        {"key": "          4", "parent": "", "text": "Other", "folder": True, "expanded": False},
        {"key": "          5", "parent": "          4", "text": "Hidden under a closed folder", "folder": False},
    ],
}

VA03_TEXTS = chrome(
    "Display Standard Order 4711: Header Data",
    N("tabsTAXI_TABSTRIP_HEAD", "GuiTabStrip",
      N("tabpT\\08", "GuiTab",
        N("cntlSPLITTER_CONTAINER", "GuiCustomControl",
          N("shellcont", "GuiContainerShell",
            N("shell", "GuiShell",
              N("shellcont[0]", "GuiContainerShell", N("shell", "GuiShell", SubType="Tree", tree=TREE)),
              N("shellcont[1]", "GuiContainerShell",
                N("shell", "GuiShell", SubType="Toolbar",
                  toolbar=[["TB_DELETE", "", "Delete text"], ["TB_DETAIL", "Detail", "Detail"], ["", "", "separator"]]),
                N("shell[1]", "GuiShell", SubType="TextEdit", Text="Deliver to gate 1.\nRing twice.")),
              SubType="Splitter"))),
        Text="Texts"),
      N("tabpT\\01", "GuiTab", Text="Sales")),
)

VA05 = chrome(
    "List of Sales Orders",
    N("cntlGRID1", "GuiCustomControl",
      N("shellcont", "GuiContainerShell",
        N("shell", "GuiShell", SubType="GridView",
          grid={"cols": [["VBELN", "Sales Doc."], ["AUDAT", "Doc. Date"], ["NETWR", "Net value"]],
                "rows": [[str(4700 + i), "01.02.2005", f"{100 * (i + 1)}.00"] for i in range(52)]}))),
    status=("", ""),
)

SE80_TREE = {
    "columns": [["&Hierarchy", "Object Name"], ["DESC", "Description"]],
    "nodes": [
        {"key": "ROOT", "parent": "", "text": "", "items": {"&Hierarchy": "ZDEMO", "DESC": "Demo package"}, "folder": True, "expanded": True},
        {"key": "N1", "parent": "ROOT", "text": "", "items": {"&Hierarchy": "Programs", "DESC": ""}, "folder": True, "expanded": True},
        {"key": "N2", "parent": "N1", "text": "", "items": {"&Hierarchy": "ZDEMO_REPORT", "DESC": "Demo report"}, "folder": False},
        {"key": "N3", "parent": "ROOT", "text": "", "items": {"&Hierarchy": "Classes", "DESC": ""}, "folder": True, "expanded": False},
        {"key": "N4", "parent": "N3", "text": "", "items": {"&Hierarchy": "ZCL_DEMO", "DESC": "Hidden"}, "folder": False},
    ],
}

SE80 = chrome(
    "Object Navigator",
    N("cntlDOCK", "GuiCustomControl",
      N("shellcont", "GuiContainerShell",
        N("shell", "GuiShell", SubType="HTMLViewer"),
        N("shell[1]", "GuiShell", SubType="Tree", tree=SE80_TREE))),
    app=[N("btn[27]", "GuiButton", Text="", Tooltip="Activate   (Ctrl+F3)", Changeable=True)],
)

F4_MAIN = chrome(
    "Create Sales Order: Initial Screen",
    N("ctxtVBAK-AUART", "GuiCTextField", Text="", Tooltip="Sales Document Type", Changeable=True, label="Order Type"),
)
F4_POPUP = popup(
    1, "Sales Document Type (1) 3 Entries found",
    N("lbl[1,1]", "GuiLabel", Text="SaTy"),
    N("lbl[6,1]", "GuiLabel", Text="Description"),
    N("lbl[1,3]", "GuiLabel", Text="CS"),
    N("lbl[6,3]", "GuiLabel", Text="Cash Sale"),
    N("lbl[1,4]", "GuiLabel", Text="OR"),
    N("lbl[6,4]", "GuiLabel", Text="Standard Order"),
    N("lbl[1,5]", "GuiLabel", Text="RE"),
    N("lbl[6,5]", "GuiLabel", Text="Returns"),
    buttons=[N("btn[0]", "GuiButton", Text="", Tooltip="Copy   (Enter)", Changeable=True),
             N("btn[12]", "GuiButton", Text="", Tooltip="Cancel   (F12)", Changeable=True)],
)

ASK_MAIN = chrome(
    "Change Standard Order 4711: Overview",
    N("txtVBAK-BSTNK", "GuiTextField", Text="PO-1", Changeable=True, label="PO Number"),
    app=[N("btn[14]", "GuiButton", Text="", Tooltip="Delete   (Shift+F2)", Changeable=True),
         N("btn[20]", "GuiButton", Text="Reject document", Tooltip="Reject document", Changeable=True)],
)
ASK_POPUP = popup(
    1, "Exit Document",
    N("txtSPOP-TEXTLINE1", "GuiTextField", Text="Data will be lost.", Changeable=False),
    N("txtSPOP-TEXTLINE2", "GuiTextField", Text="Do you want to save the document?", Changeable=False),
    N("btnSPOP-OPTION1", "GuiButton", Text="Yes", Changeable=True),
    N("btnSPOP-OPTION2", "GuiButton", Text="No", Changeable=True),
    N("btnSPOP-OPTION_CAN", "GuiButton", Text="Cancel", Tooltip="Cancel   (F12)", Changeable=True),
)

EASY = chrome(
    "SAP Easy Access",
    N("cntlIMAGE_CONTAINER", "GuiCustomControl", N("shellcont", "GuiContainerShell", N("shell", "GuiShell", SubType="Picture"))),
)


def info(tcode: str, program: str, screen: int, n: int) -> dict:
    return {"SystemName": "DEM", "Client": "100", "User": "TESTER", "Transaction": tcode, "Program": program,
            "ScreenNumber": screen, "SessionNumber": n, "Language": "EN"}


WORLD = {
    "active": "/app/con[0]/ses[1]",
    "connections": [
        {"Description": "DEM demo system", "DisabledByServer": False, "sessions": [
            {"name": "va01", "Info": info("VA01", "SAPMV45A", 101, 1), "active": "wnd[0]", "windows": [VA01]},
            {"name": "va03", "Info": info("VA03", "SAPMV45A", 4001, 2), "active": "wnd[0]", "windows": [VA03]},
            {"name": "va03-texts", "Info": info("VA03", "SAPMV45A", 4002, 3), "active": "wnd[0]", "windows": [VA03_TEXTS]},
            {"name": "va05", "Info": info("VA05", "SAPLSLVC_FULLSCREEN", 500, 4), "active": "wnd[0]", "windows": [VA05]},
            {"name": "se80", "Info": info("SE80", "SAPLSEOD", 1000, 5), "active": "wnd[0]", "windows": [SE80]},
            {"name": "f4", "Info": info("VA01", "SAPLSDH4", 120, 6), "active": "wnd[1]", "windows": [F4_MAIN, F4_POPUP]},
            {"name": "ask", "Info": info("VA02", "SAPLSPO1", 100, 7), "active": "wnd[1]", "windows": [ASK_MAIN, ASK_POPUP]},
            {"name": "easy", "Info": info("SESSION_MANAGER", "SAPLSMTR_NAVIGATION", 100, 8), "active": "wnd[0]", "windows": [EASY]},
        ]},
        {"Description": "Server without scripting", "DisabledByServer": True, "sessions": []},
    ],
}


def expand(node: dict, parent: str) -> dict:
    """Give every node its scripting Id and Name, as SAP GUI derives them."""
    seg = node.pop("seg")
    node["Id"] = f"{parent}/{seg}"
    p = PREFIX.get(node["Type"], "")
    name = seg[len(p):] if p and seg.startswith(p) and not seg.startswith("btn[") else seg
    node["Name"] = re.sub(r"\[\d+,\d+\]$", "", name) if node["Type"] != "GuiLabel" or not name.startswith("[") else name
    node["kids"] = [expand(k, node["Id"]) for k in node["kids"]]
    return node


def build() -> dict:
    w = json.loads(json.dumps(WORLD))
    for ci, con in enumerate(w["connections"]):
        con["Id"] = f"/app/con[{ci}]"
        for si, ses in enumerate(con["sessions"]):
            ses["Id"] = f"{con['Id']}/ses[{si}]"
            ses["windows"] = [expand(x, ses["Id"]) for x in ses["windows"]]
    return w


if __name__ == "__main__":
    world = build()
    (HERE / "world.json").write_text(json.dumps(world, indent=1) + "\n")
    print("ok")
