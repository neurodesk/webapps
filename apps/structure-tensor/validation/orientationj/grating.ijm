// OrientationJ 2.2.0 on one synthetic grating g<angle>.tif (scipy-reference.py formula, 128 px):
// xvfb-run java -jar ij.jar -ijpath <dir> -batch grating.ijm <angle>
name = getArgument();
open("/work/grat/g" + name + ".tif");
run("OrientationJ Analysis", "tensor=3 gradient=4 orientation=on radian=off");
for (i = 1; i <= nImages; i++) { selectImage(i); print(i + " " + getTitle()); }
selectImage(nImages);
saveAs("Tiff", "/work/grat/oj" + name + ".tif");
