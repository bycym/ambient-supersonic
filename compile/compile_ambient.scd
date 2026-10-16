(
var outDir, before, newNames;
outDir = "./supercollider_standalone/webport/synthdefs/ambient/";
if(File.exists(outDir).not) { (outDir).mkdir };

before = SynthDescLib.global.synthDescs.keys.asArray;

~az = ();
load("./supercollider_standalone/webport/compile/_extracted_ambient.scd");
~az.defineSynths[0].(nil);

newNames = SynthDescLib.global.synthDescs.keys.asArray.reject({ |k| before.includes(k) });
newNames.do { |name|
	var desc = SynthDescLib.global.synthDescs[name];
	desc.def.writeDefFile(outDir);
	("wrote: " ++ name).postln;
};
("TOTAL_AMBIENT: " ++ newNames.size).postln;
0.exit;
)
