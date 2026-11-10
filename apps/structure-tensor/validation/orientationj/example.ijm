// OrientationJ 2.2.0 on the SHG example (validation/orientationj/README in the app README).
// Run headless: xvfb-run java -jar ij.jar -ijpath <dir with plugins/OrientationJ_-2.2.0.jar> -batch example.ijm "<tensor>,<gradient>,<prefix>"
args = split(getArgument(), ",");
open("/work/data/skin12_shg_polarisation_sum.tif");
run("32-bit");
run("OrientationJ Analysis", "tensor=" + args[0] + " gradient=" + args[1] + " orientation=on coherency=on energy=on radian=off");
for (i = 1; i <= nImages; i++) {
  selectImage(i);
  t = getTitle();
  print(i + " " + t);
  saveAs("Tiff", "/work/out/" + args[2] + "_" + i + ".tif");
}
