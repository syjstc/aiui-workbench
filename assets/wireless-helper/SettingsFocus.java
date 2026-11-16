package com.aiui.workbench.wireless;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.text.TextUtils;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

/**
 * Entry point for an already authorized, interactive Workshop ADB session.
 * This is not an Android component. Installing or opening the APK cannot start it.
 */
public final class SettingsFocus {
  private static final String SETTINGS = "com.android.settings";

  private static void revealFocus(AccessibilityNodeInfo root) {
    if (root == null) return;
    AccessibilityNodeInfo focus = null;
    try {
      if (!TextUtils.equals(SETTINGS, root.getPackageName()) || !root.refresh()) return;
      focus = root.isFocused() ? root : root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
      // Android clips the reported bounds even for partly visible rows. The
      // view knows its full rectangle and whether it actually has to scroll.
      if (focus != null && focus.isFocused() && TextUtils.equals(SETTINGS, focus.getPackageName())) {
        focus.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.getId());
      }
    } finally {
      if (focus != null && focus != root) focus.recycle();
      root.recycle();
    }
  }

  public static void main(String[] args) throws Exception {
    Looper.prepare();
    HandlerThread callbacks = new HandlerThread("settings-focus");
    callbacks.start();
    UiAutomation ui = null;
    boolean connected = false;
    try {
      Object connection = Class.forName("android.app.UiAutomationConnection").getConstructor().newInstance();
      ui = UiAutomation.class.getConstructor(Looper.class, Class.forName("android.app.IUiAutomationConnection"))
        .newInstance(callbacks.getLooper(), connection);
      UiAutomation.class.getMethod("connect", int.class).invoke(ui, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
      connected = true;
      AccessibilityServiceInfo events = ui.getServiceInfo();
      events.packageNames = new String[]{SETTINGS};
      events.eventTypes = AccessibilityEvent.TYPE_VIEW_FOCUSED | AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED;
      events.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
        | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
      events.notificationTimeout = 0;
      ui.setServiceInfo(events);
      final UiAutomation active = ui;
      Handler handler = new Handler(callbacks.getLooper());
      ui.setOnAccessibilityEventListener(event -> {
        if (!TextUtils.equals(SETTINGS, event.getPackageName())) return;
        // The system's active accessibility window can lag behind keyboard
        // focus when a Settings subpage is pushed onto an existing task.
        AccessibilityNodeInfo source = event.getSource();
        if (source != null) revealFocus(source);
      });
      handler.post(() -> {
        AccessibilityNodeInfo focus = active.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        revealFocus(focus != null ? focus : active.getRootInActiveWindow());
      });
      // adb shell -T keeps stdin open only for the lifetime of this session.
      // EOF also releases the automation connection on a normal Workshop exit.
      while (System.in.read() != -1) {}
    } finally {
      if (connected) {
        ui.setOnAccessibilityEventListener(null);
        UiAutomation.class.getMethod("disconnect").invoke(ui);
      }
      callbacks.quitSafely();
    }
    System.exit(0);
  }
}
