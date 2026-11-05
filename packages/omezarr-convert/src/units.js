// Units as OME-NGFF names them (the UDUNITS-2 names its axes schema lists), from the symbols
// OME-XML, ImageJ, NIfTI and TIFF use.

const SPACE = {
  angstrom: 1e-7,
  picometer: 1e-9,
  nanometer: 1e-6,
  micrometer: 1e-3,
  millimeter: 1,
  centimeter: 10,
  meter: 1000,
  inch: 25.4,
};
const TIME = {
  nanosecond: 1e-9,
  microsecond: 1e-6,
  millisecond: 1e-3,
  second: 1,
  minute: 60,
  hour: 3600,
};
const ALIASES = {
  "å": "angstrom",
  "Å": "angstrom",
  pm: "picometer",
  nm: "nanometer",
  "µm": "micrometer",
  "μm": "micrometer",
  um: "micrometer",
  micron: "micrometer",
  microns: "micrometer",
  mm: "millimeter",
  cm: "centimeter",
  m: "meter",
  in: "inch",
  ns: "nanosecond",
  "µs": "microsecond",
  "μs": "microsecond",
  us: "microsecond",
  ms: "millisecond",
  s: "second",
  sec: "second",
  min: "minute",
  h: "hour",
};

/** The NGFF name of a space or time unit, or null when it is not one. */
export function ngffUnit(symbol) {
  if (typeof symbol !== "string") return null;
  const trimmed = symbol.trim();
  const name = ALIASES[trimmed] ?? ALIASES[trimmed.toLowerCase()] ?? trimmed.toLowerCase();
  return name in SPACE || name in TIME ? name : null;
}

export const isSpaceUnit = (unit) => unit in SPACE;
export const isTimeUnit = (unit) => unit in TIME;

/** Millimetres per one of `unit` (a space unit), for NIfTI headers. */
export function millimetresPer(unit) {
  const factor = SPACE[unit];
  if (factor === undefined) throw new Error(`${unit} is not a length unit.`);
  return factor;
}

/** NIfTI xyzt_units: spatial in bits 0-2 (1 m, 2 mm, 3 µm), time in bits 3-5 (8 s, 16 ms, 24 µs). */
export function niftiUnits(xyztUnits) {
  return {
    space: { 1: "meter", 2: "millimeter", 3: "micrometer" }[xyztUnits & 7] ?? null,
    time: { 8: "second", 16: "millisecond", 24: "microsecond" }[xyztUnits & 56] ?? null,
  };
}
