ObjC.import('AppKit');
ObjC.import('CoreGraphics');
ObjC.import('ApplicationServices');
ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
ObjC.bindFunction('CGRequestScreenCaptureAccess', ['bool', []]);
// NSData holds UTF-16 bytes; expose its pointer with the UniChar type required by keyboard events.
ObjC.bindFunction('CFDataGetBytePtr', ['unsigned short *', ['id']]);

// JXA owns bridged Core Foundation objects; manual CFRelease would double-free them.
function postKey(code, down, flags) {
  const event = $.CGEventCreateKeyboardEvent(null, code, down);
  $.CGEventSetFlags(event, flags || 0);
  $.CGEventPost($.kCGHIDEventTap, event);
}

// Approval brings DeskPG forward; never post input until the explicitly chosen App owns focus again.
function focusApplication(bundleId) {
  const applications = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId);
  if (!applications.count) {
    throw Error('目标 App 尚未运行');
  }
  const application = applications.objectAtIndex(0);
  if (!application.activateWithOptions($.NSApplicationActivateIgnoringOtherApps)) {
    throw Error('目标 App 无法激活');
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    if ($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier === application.processIdentifier) {
      return;
    }
    // AppKit activation is asynchronous; let its run loop deliver focus updates before checking again.
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
  }
  throw Error('目标 App 激活超时，未执行操作');
}

function run(argv) {
  const input = JSON.parse(argv[0]);
  if (input.action === 'permissions') {
    return JSON.stringify({ screen: $.CGPreflightScreenCaptureAccess(), accessibility: $.AXIsProcessTrusted() });
  }
  if (input.action === 'authorize') {
    $.CGRequestScreenCaptureAccess();
    $.AXIsProcessTrustedWithOptions($({ AXTrustedCheckOptionPrompt: true }));
    return JSON.stringify({ requested: true });
  }
  if (input.bundleId) {
    focusApplication(input.bundleId);
  }
  const frame = $.NSScreen.screens.objectAtIndex(0).frame;
  const scale = Math.min(1, 1280 / frame.size.width);
  const imageWidth = Math.round(frame.size.width * scale);
  const imageHeight = Math.round(frame.size.height * scale);
  if (input.action === 'dimensions') { return JSON.stringify({ imageWidth, imageHeight }); }
  if (!$.AXIsProcessTrusted()) { throw Error('辅助功能未授权'); }
  if (input.action === 'click') {
    if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.y < 0
      || input.x >= imageWidth || input.y >= imageHeight) { throw Error('点击坐标超出截图'); }
    const point = $.CGPointMake(input.x / scale, input.y / scale);
    for (const type of [$.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp]) {
      const event = $.CGEventCreateMouseEvent(null, type, point, $.kCGMouseButtonLeft);
      $.CGEventPost($.kCGHIDEventTap, event);
    }
  } else if (input.action === 'type') {
    if (typeof input.text !== 'string' || input.text.length > 10000) { throw Error('输入文本无效'); }
    // Use UTF-16 buffers; JS arrays silently fall back to the virtual key code in JXA.
    const characters = Array.from(input.text);
    for (let index = 0; index < characters.length; index += 20) {
      const text = characters.slice(index, index + 20).join('');
      const bytes = $(text).dataUsingEncoding($.NSUTF16LittleEndianStringEncoding);
      const event = $.CGEventCreateKeyboardEvent(null, 0, true);
      $.CGEventSetFlags(event, 0);
      $.CGEventKeyboardSetUnicodeString(event, text.length, $.CFDataGetBytePtr(bytes));
      $.CGEventPost($.kCGHIDEventTap, event);
      $.CGEventSetType(event, $.kCGEventKeyUp);
      $.CGEventPost($.kCGHIDEventTap, event);
      $.NSThread.sleepForTimeInterval(0.01);
    }
  } else if (input.action === 'key') {
    const keys = { ENTER: 36, TAB: 48, SPACE: 49, BACKSPACE: 51, ESC: 53, LEFT: 123, RIGHT: 124, DOWN: 125, UP: 126,
      HOME: 115, END: 119, PAGEUP: 116, PAGEDOWN: 121, DELETE: 117, A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7,
      C: 8, V: 9, B: 11, Q: 12, W: 13, E: 14, R: 15, Y: 16, T: 17, O: 31, U: 32, I: 34, P: 35, L: 37, J: 38,
      K: 40, N: 45, M: 46, '0': 29, '1': 18, '2': 19, '3': 20, '4': 21, '5': 23, '6': 22, '7': 26, '8': 28, '9': 25 };
    const parts = String(input.key || '').toUpperCase().split('+');
    const code = keys[parts.pop()];
    const modifiers = { CMD: $.kCGEventFlagMaskCommand, CTRL: $.kCGEventFlagMaskControl,
      ALT: $.kCGEventFlagMaskAlternate, SHIFT: $.kCGEventFlagMaskShift };
    if (code === undefined || parts.some(part => modifiers[part] === undefined)) { throw Error('不支持的按键'); }
    const flags = parts.reduce((value, part) => value | modifiers[part], 0);
    postKey(code, true, flags);
    postKey(code, false, flags);
  } else if (input.action === 'scroll') {
    if (!Number.isInteger(input.amount) || Math.abs(input.amount) > 2000) { throw Error('滚动距离无效'); }
    const event = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitPixel, 1, input.amount);
    $.CGEventPost($.kCGHIDEventTap, event);
  } else {
    throw Error('不支持的电脑操作');
  }
  return JSON.stringify({ ok: true });
}
