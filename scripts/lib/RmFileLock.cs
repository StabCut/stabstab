using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

// Reports which processes hold a given file open, using the Windows Restart Manager --
// the same API the shell's "file is in use" dialog uses. It sees handle owners that a
// process-name guess would miss: on 2026-10-16 the holder of
// release\win-unpacked.tmp\resources\default_app.asar was a Typora RENDERER process,
// not the Typora process a human would have suspected.
//
// Used by scripts\clean-release.ps1 (preflight for scripts\package.cmd).
// Kept in its own .cs file on purpose: passing this source through an Add-Type
// -TypeDefinition here-string fails here with CS1040, while -Path compiles cleanly.
public static class RmFileLock
{
    [StructLayout(LayoutKind.Sequential)]
    struct RM_UNIQUE_PROCESS
    {
        public int dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    const int CCH_RM_MAX_APP_NAME = 255;
    const int CCH_RM_MAX_SVC_NAME = 63;
    const int ERROR_MORE_DATA = 234;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct RM_PROCESS_INFO
    {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_APP_NAME + 1)] public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_SVC_NAME + 1)] public string strServiceShortName;
        public int ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);

    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint pSessionHandle);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames,
        uint nApplications, object[] rgApplications, uint nServices, string[] rgsServiceNames);

    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo,
        [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

    // Returns one "pid|processName|serviceShortName" entry per holding process.
    // Empty list when nothing holds the file (also when the query itself fails).
    public static List<string> Who(string path)
    {
        var result = new List<string>();
        uint handle;
        string key = Guid.NewGuid().ToString();
        if (RmStartSession(out handle, 0, key) != 0) { return result; }

        try
        {
            if (RmRegisterResources(handle, 1, new string[] { path }, 0, null, 0, null) != 0)
            {
                return result;
            }

            uint needed = 0;
            uint count = 0;
            uint reasons = 0;
            int r = RmGetList(handle, out needed, ref count, null, ref reasons);
            if (r == ERROR_MORE_DATA) { count = needed; }
            else if (r != 0 || count == 0) { return result; }

            var infos = new RM_PROCESS_INFO[count];
            if (RmGetList(handle, out needed, ref count, infos, ref reasons) != 0)
            {
                return result;
            }

            for (uint i = 0; i < count; i++)
            {
                result.Add(infos[i].Process.dwProcessId + "|" + infos[i].strAppName + "|" +
                           (infos[i].strServiceShortName ?? ""));
            }
        }
        finally
        {
            RmEndSession(handle);
        }

        return result;
    }
}
