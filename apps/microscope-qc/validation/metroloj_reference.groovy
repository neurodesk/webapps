// Reference numbers for microscope-qc, run in Fiji (ImageJ 1) headless with the MetroloJ_QC
// 1.3.1.2 jar on the class path (validation/reference.mjs runs it in the pinned Docker image).
//
// PSF: ImageJ's MaximumFinder finds the maxima of the ZProjector maximum projection with the
// given prominence; for every bead centre listed in `centres` (from the app) the profiles are
// taken exactly as MetroloJ_QC's PSFprofiler does (ImageProcessor.getLine across the crop for x
// and y, a Slicer reslice for z) and fitted with MetroloJ_QC's own CurveFitterPlus (ImageJ's
// Gaussian, MetroloJ_QC's starting values). Field: ImageJ's GaussianBlur (σ = 2), then the
// field-illumination formulas restated in Groovy below. Those formulas are written by the same
// author as the app, so they are not an independent check; test/field.test.js pins them to a
// published MetroloJ_QC report instead.
//
// Arguments (key=value, comma separated): stack, centres, halfBox, prominence, px, pz, field, out
#@ String args
import ij.IJ
import ij.ImagePlus
import ij.ImageStack
import ij.plugin.ZProjector
import ij.plugin.Slicer
import ij.plugin.filter.MaximumFinder
import ij.plugin.filter.GaussianBlur
import ij.gui.Line
import ij.measure.Calibration
import ij.process.ImageStatistics
import ij.measure.Measurements
import utilities.miscellaneous.CurveFitterPlus

def opts = args.split(',').collectEntries { it.split('=', 2) as List }
def out = new StringBuilder()
def emit = { String line -> out.append(line).append('\n') }

def stack = IJ.openImage(opts.stack)
if (stack.getNSlices() == 1 && stack.getNFrames() > 1) stack.setDimensions(1, stack.getNFrames(), 1)
def halfBox = opts.halfBox as int
double px = opts.px as double
double pz = opts.pz as double
def mip = ZProjector.run(stack, 'max')
def maxima = new MaximumFinder().getMaxima(mip.getProcessor(), opts.prominence as double, true, false)
emit("maxima,${maxima.npoints}")
for (int i = 0; i < maxima.npoints; i++) emit("maximum,${maxima.xpoints[i]},${maxima.ypoints[i]}")

def sqrt2ln2 = Math.sqrt(2 * Math.log(2))
new File(opts.centres).eachLine { line, n ->
  if (n == 1) return
  def (id, cxs, cys) = line.split(',')
  int cx0 = cxs as int
  int cy0 = cys as int
  int size = 2 * halfBox + 1
  def cropStack = new ImageStack(size, size)
  for (int z = 1; z <= stack.getNSlices(); z++) {
    def ip = stack.getStack().getProcessor(z)
    ip.setRoi(cx0 - halfBox, cy0 - halfBox, size, size)
    cropStack.addSlice(ip.crop())
  }
  def crop = new ImagePlus('bead', cropStack)
  def cal = new Calibration()
  cal.pixelWidth = px
  cal.pixelHeight = px
  cal.pixelDepth = pz
  cal.setUnit('micron')
  crop.setCalibration(cal)
  // findSingleBeadCentre, maximum-intensity method: brightest pixel of the projection, then the brightest plane.
  def proj = ZProjector.run(crop, 'max').getProcessor()
  int bx = 0, by = 0, best = 0
  for (int y = 0; y < size; y++) for (int x = 0; x < size; x++) { int v = proj.getPixel(x, y); if (v > best) { best = v; bx = x; by = y } }
  int bz = 1
  double zbest = -1
  for (int z = 1; z <= crop.getNSlices(); z++) { double v = crop.getStack().getProcessor(z).getPixelValue(bx, by); if (v > zbest) { zbest = v; bz = z } }
  crop.setSlice(bz)
  def fits = []
  def xFit = new CurveFitterPlus(crop.getProcessor().getLine(0.0, by, size - 1, by), 'micron', px, 'x', 'I', 0)
  def yFit = new CurveFitterPlus(crop.getProcessor().getLine(bx, 0.0, bx, size - 1), 'micron', px, 'y', 'I', 0)
  crop.setCalibration(new Calibration())
  crop.setRoi(new Line(0.0, by, size - 1, by))
  def crossX = new Slicer().reslice(crop)
  crop.killRoi()
  def zFit = new CurveFitterPlus(crossX.getProcessor().getLine(bx, 0.0, bx, crossX.getHeight() - 1), 'micron', pz, 'z', 'I', 0)
  def values = []
  ['x', 'y', 'z'].eachWithIndex { axis, k -> emit("profile,${id},${axis},${[xFit, yFit, zFit][k].profiles[1].join(',')}") }
  for (f in [xFit, yFit, zFit]) {
    f.fitProfile(12)
    values << 2 * sqrt2ln2 * f.params[3]
    values << f.R2
  }
  emit("bead,${id},${cx0 - halfBox + bx},${cy0 - halfBox + by},${bz - 1},${values.join(',')}")
}

if (opts.field && opts.field != 'none') {
  def field = IJ.openImage(opts.field)
  def ip = field.getProcessor()
  new GaussianBlur().blurGaussian(ip, 2.0)
  int w = ip.getWidth(), h = ip.getHeight()
  def stats = ip.getStats()
  double min = stats.min, max = stats.max
  def norm = new ij.process.ByteProcessor(w, h)
  for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) norm.set(x, y, (int) ((int) (ip.getPixel(x, y) / max * 100.0 / 10.0) * 10.0))
  def zone = new ImagePlus('zone', norm)
  norm.setThreshold(90.0, 100.0, ij.process.ImageProcessor.NO_LUT_UPDATE)
  def zs = zone.getStatistics(Measurements.CENTROID | Measurements.LIMIT)
  double cent = 100.0 - 200.0 * Math.sqrt(Math.pow(zs.xCentroid - (w / 2 as int), 2) + Math.pow(zs.yCentroid - (h / 2 as int), 2)) / Math.sqrt(w * w + h * h)
  def border = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1], [w / 2 as int, 0], [w / 2 as int, h - 1], [0, h / 2 as int], [w - 1, h / 2 as int]].collect { ip.getPixel(it[0], it[1]) as double }
  double mean = border.sum() / border.size()
  double sd = Math.sqrt(border.collect { (it - mean) * (it - mean) }.sum() / border.size())
  emit("field,${100.0 * min / max},${100.0 - 100.0 * sd / max},${cent},${min},${max},${zs.xCentroid},${zs.yCentroid}")
  def pixels = []
  int stride = w * h > 100000 ? 997 : 1
  for (int i = 0; i < w * h; i += stride) pixels << ip.get(i)
  emit("blurred,${pixels.join(',')}")
}
new File(opts.out).text = out.toString()
println("wrote ${opts.out}")
System.exit(0)
