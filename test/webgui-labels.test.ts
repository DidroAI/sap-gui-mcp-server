import { describe, expect, test } from "bun:test";
import { mergeLabels } from "../src/webgui/labels.js";

const U = "wnd[0]/usr/tabsTAXI/tabpT\\11/ssubBODY:SAPMV45A:4305";

describe("labels drawn apart from their field (S/4HANA Web GUI)", () => {
  test("a label goes into the field after it, as on ECC, and its line goes", () => {
    expect(
      mergeLabels([
        `${U}/lblVBUK-CMGST  label  OverallCredStat`,
        `${U}/txtVBSTT-CMGST_BEZ  field  Description = "Not Performed"  (read-only)`,
        `${U}/lblVBUK-LFSTK  label  Delivery Status`,
        `${U}/txtVBSTT-LFSTA_BEZ  field  Delivery status description = "Not Delivered"  (read-only)`,
      ]),
    ).toEqual([`${U}/txtVBSTT-CMGST_BEZ  field  OverallCredStat = "Not Performed"  (read-only)`, `${U}/txtVBSTT-LFSTA_BEZ  field  Delivery Status = "Not Delivered"  (read-only)`]);
  });
  test("a label with the field's own text is dropped; a dropdown takes one too", () => {
    expect(mergeLabels(["wnd[0]/usr/lblBUT000-NAME_ORG1  label  Name", 'wnd[0]/usr/txtBUT000-NAME_ORG1  field  Name = "Foreign US Supplier"  (read-only)'])).toEqual(['wnd[0]/usr/txtBUT000-NAME_ORG1  field  Name = "Foreign US Supplier"  (read-only)']);
    expect(mergeLabels(["wnd[0]/usr/lblX-T  label  Title", 'wnd[0]/usr/cmbX-T  dropdown  Form of address key = "0003" Company  (read-only)'])).toEqual(['wnd[0]/usr/cmbX-T  dropdown  Title = "0003" Company  (read-only)']);
  });
  test("a label in front of several fields: a first field that says the same keeps its text", () => {
    expect(
      mergeLabels([
        "wnd[0]/usr/txtADDR1_KEYW-STREET  label  Street/House Number",
        'wnd[0]/usr/txtADDR1_DATA-STREET  field  Street Name = "Stollberger Str."  (read-only)',
        'wnd[0]/usr/txtADDR1_DATA-HOUSE_NUM1  field  House Number = "5"  (read-only)',
      ]),
    ).toEqual(['wnd[0]/usr/txtADDR1_DATA-STREET  field  Street Name = "Stollberger Str."  (read-only)', 'wnd[0]/usr/txtADDR1_DATA-HOUSE_NUM1  field  House Number = "5"  (read-only)']);
  });
  test("a selection screen's texts go to the fields they name, wherever they stand", () => {
    expect(
      mergeLabels([
        "wnd[0]/usr/txt%_SAUART_%_APP_%-TEXT  label  Order Type",
        'wnd[0]/usr/txt%_SAUART_%_APP_%-OPTI_PUSH  label  icon "Select: Not equal to"',
        'wnd[0]/usr/ctxtSAUART-LOW  field  Sales Document Type = ""  (edit)',
        "wnd[0]/usr/txt%_SAUART_%_APP_%-TO_TEXT  label  to",
        'wnd[0]/usr/ctxtSAUART-HIGH  field  Sales Document Type = ""  (edit)',
        "wnd[0]/usr/txt%_P_VARI_%_APP_%-TEXT  label  Layout",
        'wnd[0]/usr/ctxtP_VARI  field  Layout = ""  (edit)',
      ]),
    ).toEqual([
      'wnd[0]/usr/txt%_SAUART_%_APP_%-OPTI_PUSH  label  icon "Select: Not equal to"',
      'wnd[0]/usr/ctxtSAUART-LOW  field  Order Type = ""  (edit)',
      'wnd[0]/usr/ctxtSAUART-HIGH  field  to = ""  (edit)',
      'wnd[0]/usr/ctxtP_VARI  field  Layout = ""  (edit)',
    ]);
  });
  test("a label with no field after it, in another container, or before a table cell stays", () => {
    const lines = [
      "wnd[0]/usr/txtSPOP-DIAGNOSE1  label  For this material TG11",
      "wnd[0]/usr/btnSPOP-VAROPTION1  button  Continue",
      "wnd[0]/usr/lblA  label  Header",
      'wnd[0]/usr/subS/txtB  field  B = ""  (edit)',
      "wnd[0]/usr/lblC  label  Item",
      'wnd[0]/usr/tblT/txtC[1,0]  field   = "10"  (read-only)',
    ];
    expect(mergeLabels(lines)).toEqual(lines);
  });
});
