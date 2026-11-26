/**
 * ScopeLang text for the demo, consistent with mock/bakery.js: the header of the generated
 * source, the canonical snippet from the spec, and the compiler diagnostics on record.
 * Imported only by services/compiler.js.
 * @module mock/scopelang-source
 */

export const HEADER = `// MillionScope · Should our bakery open a second location?
// Written by the Modeler under grammar-constrained decoding, compiled to Scope IR.
// Every number below carries provenance: input · observed @src · estimate @by · computed.`;

/** The canonical example from the specification (the simplified core of the demo graph). */
export const DEMO_SNIPPET = `use std.finance.{Business, Loan}

scope Bakery : Business {
  input    price:        USD/loaf  = 4.00
  input    rent:         USD/month = 6_500
  observed unit_cost:    USD/loaf  = 1.35  @src("supplier_invoice_oct.pdf", page=2)
  estimate demand:       loaf/day  ~ LogNormal(median=310, p90=420)  @by("ms-8b")
  computed gross_margin: USD/day   = (price - unit_cost) * demand
  constraint price > unit_cost

  child expansion : Loan {
    input principal: USD    = 180_000
    input rate:      1/year = 0.085
    input term:      year   = 7
    // payment: USD/month is inherited from Loan
  }

  computed monthly_cash: USD/month =
    convert(gross_margin, USD/month) - rent - expansion.payment
}`;

/**
 * Diagnostics on record from the build (the Skeptic's rejected rewire). They are shown in the
 * gutter of the target's line; live compiler errors are added by the compiler service.
 */
export const BUILD_DIAGNOSTICS = [
  {
    nodeId: 'sc_7Q2f.net_cash',
    severity: 'warning',
    message: 'rejected in build: unit mismatch in sc_7Q2f.net_cash: USD/day - USD/month; wrap the first term in convert(..., USD/month)',
  },
];
