package local.aiui.workbench;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.os.Looper;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import org.json.JSONArray;
import org.json.JSONObject;

/** Read-only shell helper. No Activity, installed APK, network or storage permission. */
public final class AppInfo {
    public static void main(String[] packages) throws Exception {
        if (Looper.getMainLooper() == null) Looper.prepareMainLooper();
        Class<?> threadClass = Class.forName("android.app.ActivityThread");
        Object thread = threadClass.getMethod("systemMain").invoke(null);
        Context context = (Context) threadClass.getMethod("getSystemContext").invoke(thread);
        PackageManager manager = context.getPackageManager();
        JSONArray apps = new JSONArray();
        for (String name : packages) {
            JSONObject app = new JSONObject(); app.put("packageName", name);
            try {
                ApplicationInfo info = manager.getApplicationInfo(name, 0);
                app.put("label", String.valueOf(manager.getApplicationLabel(info)));
                Bitmap bitmap = null;
                try {
                    Drawable icon = manager.getApplicationIcon(info);
                    bitmap = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888);
                    icon.setBounds(0, 0, 96, 96); icon.draw(new Canvas(bitmap));
                    ByteArrayOutputStream output = new ByteArrayOutputStream();
                    bitmap.compress(Bitmap.CompressFormat.PNG, 100, output);
                    app.put("icon", "data:image/png;base64," + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP));
                } catch (Throwable error) { app.put("iconError", error.getClass().getSimpleName()); }
                finally { if (bitmap != null) bitmap.recycle(); }
            } catch (Throwable error) { app.put("error", error.getClass().getSimpleName()); }
            apps.put(app);
        }
        JSONObject result = new JSONObject(); result.put("schemaVersion", 1); result.put("apps", apps);
        System.out.println("AIUI_APP_INFO " + result.toString());
    }
}
