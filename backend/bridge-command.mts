// Unified application entry. Only upload uses the network, after confirmation in a real TTY.
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { bridgeFrameworkOverview } from './bridge-sources.mts';
import { inspectImportTask, listImportTasks, prepareImportTask, selectImportTaskChatGptGuide, selectImportTaskQueries, uploadImportTask } from './bridge-import-tasks.mts';
import { boundedSleepJson as boundedJson } from './trainingcamp-sleep-files.mts';
import { MAX_TRAININGCAMP_ACTIVITY_CAPTURES, MAX_TRAININGCAMP_CAPTURE_BYTES } from './trainingcamp-capture.mts';
import { parseTrainingCampJson } from './trainingcamp-semantics.mts';
import { bridgeCommandError } from './bridge-errors.mts';
import { previewBridgeImport } from './bridge-import.mts';

async function readInput(path: string, max: number, parse?: (text: string) => unknown) {
  try { return await boundedJson(path, max, parse); }
  catch { throw new Error('local_file_invalid'); }
}

async function readActivityCaptureFiles(paths: string[]) {
  if (paths.length < 2 || paths.length > MAX_TRAININGCAMP_ACTIVITY_CAPTURES) throw new Error('invalid_bridge_command');
  const captures = [];
  let remaining = MAX_TRAININGCAMP_CAPTURE_BYTES;
  for (const path of paths) {
    captures.push(await readInput(path, remaining, text => {
      remaining -= Buffer.byteLength(text);
      return parseTrainingCampJson(text);
    }));
  }
  return { captures };
}

try {
  const [command = 'overview', ...args] = process.argv.slice(2);
  let result;
  if (command === 'overview' && args.length === 0) result = bridgeFrameworkOverview();
  else if (command === 'list' && args.length <= 1) result = await listImportTasks(args[0]);
  else if (command === 'prepare' || command === 'preview') {
    if (args[0] !== 'sleep' && args[0] !== 'activity') throw new Error('invalid_bridge_command');
    const multiple = args.length > 4 && args[0] === 'activity' && args[1] === '--captures';
    if (!multiple && args.length !== 4) throw new Error('invalid_bridge_command');
    const input = multiple
      ? await readActivityCaptureFiles(args.slice(2, -2))
      : await readInput(args[1], MAX_TRAININGCAMP_CAPTURE_BYTES, args[0] === 'activity' ? parseTrainingCampJson : JSON.parse);
    const [start, end] = args.slice(-2), window = { start, end };
    result = command === 'preview' ? previewBridgeImport(args[0], input, window) : await prepareImportTask(args[0], input, window);
  } else if (command === 'inspect' && args.length === 1) result = await inspectImportTask(args[0]);
  else if (command === 'queries' && args.length === 1) result = await selectImportTaskQueries(args[0]);
  else if (command === 'chatgpt' && args.length === 1) result = await selectImportTaskChatGptGuide(args[0]);
  else if (command === 'upload' && args.length === 2) {
    if (!stdin.isTTY || !stdout.isTTY) throw new Error('interactive_terminal_required');
    const config = await readInput(args[1], 65536);
    result = await uploadImportTask(args[0], config, async preview => {
      stdout.write('请核对数据类别、日期、目标及配置声明的账号/安装（不等同于服务端已核实身份）：\n' + JSON.stringify(preview, null, 2) + '\n');
      const rl = createInterface({ input: stdin, output: stdout });
      try { return (await rl.question(`仅输入“上传 ${preview.destination}”才发送，否则取消：`)).trim() === `上传 ${preview.destination}`; }
      finally { rl.close(); }
    });
  } else throw new Error('invalid_bridge_command');
  stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  console.error(JSON.stringify(bridgeCommandError(error)));
  process.exitCode = 1;
}
