package com.aiui.workbench.wireless;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.service.quicksettings.TileService;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.Locale;

/** Opens the user's chosen system settings page. */
public final class SetupActivity extends Activity {
  private boolean english;
  private long lastConfirm = -1000;
  private Button next;
  private TextView instructions;

  private String text(String zh, String en) { return english ? en : zh; }

  @Override public void onCreate(Bundle saved) {
    super.onCreate(saved);
    english = !Locale.getDefault().getLanguage().equals("zh");
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    LinearLayout box = new LinearLayout(this);
    box.setOrientation(LinearLayout.VERTICAL);
    box.setGravity(Gravity.CENTER_VERTICAL);
    box.setPadding(24, 12, 24, 12);
    box.setBackgroundColor(Color.BLACK);
    TextView title = new TextView(this);
    title.setTextColor(Color.GREEN);
    title.setTextSize(23);
    title.setText(text("AIUI 无线助手", "AIUI Wireless Setup"));
    box.addView(title);
    instructions = new TextView(this);
    instructions.setTextColor(Color.GREEN);
    instructions.setTextSize(18);
    instructions.setPadding(0, 12, 0, 12);
    box.addView(instructions);
    next = new Button(this);
    next.setTextSize(19);
    next.setAllCaps(false);
    next.setFocusableInTouchMode(true);
    next.setOnKeyListener((view, key, event) -> {
      if (key != KeyEvent.KEYCODE_ENTER && key != KeyEvent.KEYCODE_DPAD_CENTER) return false;
      if (event.getAction() == KeyEvent.ACTION_UP && !event.isCanceled()) {
        long previous = lastConfirm;
        lastConfirm = event.getEventTime();
        if (lastConfirm - previous >= 360) view.performClick();
      }
      return true;
    });
    box.addView(next);
    ScrollView scroll = new ScrollView(this);
    scroll.setFillViewport(true);
    scroll.addView(box);
    setContentView(scroll);
  }

  private Intent setupPage(String action) {
    // Android 12 Settings uses the setup layout without the tall collapsing
    // title for these onboarding pages. Other Settings apps may ignore the hint.
    return new Intent(action).putExtra("isSetupFlow", true);
  }

  @Override public void onResume() {
    super.onResume();
    boolean enabled = Settings.Global.getInt(getContentResolver(), Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) == 1;
    if (enabled) showWireless();
    else showBuildNumber();
    next.requestFocus();
  }

  @Override public void onPause() {
    lastConfirm = -1000;
    super.onPause();
  }

  private void offer(String label, String guidance, Intent destination, Runnable unavailable) {
    instructions.setText(guidance);
    next.setText(label);
    next.setEnabled(true);
    next.setOnClickListener(view -> {
      try { startActivity(destination); }
      catch (ActivityNotFoundException | SecurityException error) { unavailable.run(); }
    });
  }

  private void showBuildNumber() {
    offer(text("打开设备信息", "Open device info"),
      text("用镜腿或遥控器选中最下面的“版本号”，连点 7 次，再返回助手。\n",
           "Use the temple or remote to select Build number at the bottom. Tap it seven times, then return here.\n") + Build.DISPLAY,
      setupPage(Settings.ACTION_DEVICE_INFO_SETTINGS), () -> showSystemFallback(false));
  }

  private String manualFocusHint() {
    return text("在“开发者选项”里，先滑动镜腿，看着焦点框移到“无线调试”这一行再点。保留顶部总开关开启。",
                "In Developer options, swipe until the focus outline is on the Wireless debugging row, then tap. Leave the top switch on.");
  }

  private void showWireless() {
    Intent shortcut = wirelessTileSettings();
    if (shortcut == null) { showDeveloperOptions(); return; }
    offer(text("打开无线调试", "Open wireless debugging"),
      text("开启无线调试。选“配对码”把六位数字填到电脑；或选“二维码”扫描工坊的配对二维码。",
           "Turn on wireless debugging. Enter its pairing code in Workshop, or use Pair device with QR code to scan the Workshop pairing QR."),
      shortcut, this::showDeveloperOptions);
  }

  private Intent wirelessTileSettings() {
    // Use the Settings app's own tile-details handler. The tile is normally
    // disabled until added to Quick Settings. Its declaration is sufficient.
    PackageManager pm = getPackageManager();
    int flags = PackageManager.MATCH_DEFAULT_ONLY | PackageManager.MATCH_SYSTEM_ONLY;
    ResolveInfo developer = pm.resolveActivity(new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS), flags);
    if (developer == null || developer.activityInfo == null) return null;
    ActivityInfo dashboard = developer.activityInfo;
    Intent details = setupPage(TileService.ACTION_QS_TILE_PREFERENCES).setPackage(dashboard.packageName);
    ComponentName dashboardName = new ComponentName(dashboard.packageName, dashboard.name);
    boolean handlesDetails = false;
    for (ResolveInfo handler : pm.queryIntentActivities(details, flags)) {
      ActivityInfo info = handler.activityInfo;
      if (info.exported && dashboardName.equals(new ComponentName(info.packageName, info.name))) {
        handlesDetails = true;
        break;
      }
    }
    if (!handlesDetails) return null;
    Intent tiles = new Intent(TileService.ACTION_QS_TILE).setPackage(dashboard.packageName);
    for (ResolveInfo entry : pm.queryIntentServices(tiles, PackageManager.MATCH_DISABLED_COMPONENTS | PackageManager.MATCH_SYSTEM_ONLY)) {
      ServiceInfo tile = entry.serviceInfo;
      if (tile.name.endsWith(".development.qstile.DevelopmentTiles$WirelessDebugging")) {
        // The system opens its wireless subpage from the dashboard. Back should
        // return to the helper, away from the dashboard's master switch.
        return details.setComponent(dashboardName).addFlags(Intent.FLAG_ACTIVITY_NO_HISTORY)
          .putExtra(Intent.EXTRA_COMPONENT_NAME, new ComponentName(tile.packageName, tile.name));
      }
    }
    return null;
  }

  private void showDeveloperOptions() {
    // Search-result highlights in Settings scroll a row into view without
    // moving D-pad focus. Start at the real focus position on this firmware.
    offer(text("手动选择无线调试", "Select wireless debugging manually"), manualFocusHint(),
      setupPage(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS), () -> showSystemFallback(true));
  }

  private void showSystemFallback(boolean developer) {
    String guidance = developer ? manualFocusHint()
      : text("在设置里打开设备信息，滑动选中“版本号”，连点 7 次后返回助手。\n",
             "Open Device info, swipe to focus Build number, tap seven times and return here.\n") + Build.DISPLAY;
    offer(text("打开系统设置", "Open system settings"), guidance, setupPage(Settings.ACTION_SETTINGS), () -> {
      instructions.setText(text("这副眼镜未开放系统设置入口。", "System settings are unavailable on these glasses."));
      next.setEnabled(false);
    });
  }
}
