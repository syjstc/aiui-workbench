package com.aiui.workbench;

import android.os.IBinder;
import java.io.File;
import java.lang.reflect.Array;
import java.lang.reflect.InvocationTargetException;
import java.util.Map;
import org.json.JSONObject;

/**
 * Runs with the existing authorized ADB shell identity. Calls the framework's
 * named interface instead of guessing Binder transaction numbers. No root,
 * permission grants, key-file edits or permanent application installation.
 */
public final class AdbTrust {
    private static int count(Object devices) {
        if (devices instanceof Map) return ((Map<?, ?>) devices).size();
        if (devices != null && devices.getClass().isArray()) return Array.getLength(devices);
        throw new IllegalStateException("Unsupported paired-device response");
    }
    public static void main(String[] args) throws Exception {
        JSONObject result = new JSONObject();
        result.put("supported", false);
        result.put("revoked", false);
        try {
            if (args.length < 1 || !("inspect".equals(args[0]) || "revoke".equals(args[0]))) {
                throw new IllegalArgumentException("Expected inspect or revoke");
            }
            IBinder binder = (IBinder) Class.forName("android.os.ServiceManager")
                .getMethod("getService", String.class).invoke(null, "adb");
            Class<?> contract = Class.forName("android.debug.IAdbManager");
            Object manager = Class.forName("android.debug.IAdbManager$Stub")
                .getMethod("asInterface", IBinder.class).invoke(null, binder);
            contract.getMethod("clearDebuggingKeys");
            int before = count(contract.getMethod("getPairedDevices").invoke(manager));
            result.put("supported", true);
            result.put("pairedCount", before);
            if ("revoke".equals(args[0])) {
                contract.getMethod("clearDebuggingKeys").invoke(manager);
                int remaining = before;
                // The service removes its keystore on a handler thread.
                for (int i = 0; i < 20; i++) {
                    Thread.sleep(100);
                    remaining = count(contract.getMethod("getPairedDevices").invoke(manager));
                    if (remaining == 0) break;
                }
                result.put("remainingCount", remaining);
                result.put("revoked", remaining == 0);
            }
        } catch (Throwable error) {
            Throwable cause = error instanceof InvocationTargetException
                ? ((InvocationTargetException) error).getTargetException() : error;
            result.put("error", cause.getClass().getSimpleName());
        } finally {
            // Remove only the uniquely named helper supplied by Workshop.
            if (args.length > 1 && args[1].matches("/data/local/tmp/aiui-adb-trust-[a-f0-9-]+\\.jar")) {
                new File(args[1]).delete();
            }
        }
        System.out.println("AIUI_ADB_TRUST=" + result.toString());
    }
}
