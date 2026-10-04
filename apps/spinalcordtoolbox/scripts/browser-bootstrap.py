import os
import sys
import types

sys.path[:0] = ['/sct', '/deps']
os.environ['MPLBACKEND'] = 'Agg'

def unavailable_platform_api(name):
    raise RuntimeError('Unavailable browser platform API: ' + name)

for module_name in ['psutil', 'portalocker']:
    module = types.ModuleType(module_name)
    module.__file__ = ''
    module.__getattr__ = unavailable_platform_api
    sys.modules[module_name] = module

import tqdm
tqdm.tqdm.monitor_interval = 0

from spinalcordtoolbox.scripts import sct_process_segmentation, sct_analyze_lesion

SCT_COMMANDS = {
    'process_segmentation': sct_process_segmentation.main,
    'analyze_lesion': sct_analyze_lesion.main,
}
