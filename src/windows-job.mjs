// Windows 10+: use the built-in PowerShell/.NET runtime, not an installed
// helper binary. The native job is attached at CreateProcessW, before the
// child can create descendants; only stdin/out/err handles are inherited.
// https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
import path from 'node:path';

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SEVERALLY_PROCESS_SPEC)) | ConvertFrom-Json
  [Environment]::SetEnvironmentVariable('SEVERALLY_PROCESS_SPEC', $null)
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SeverallyJob {
  public static bool Launched;
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long user, job; public uint flags; public UIntPtr min, max; public uint active; public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct Limits { public Basic basic; public Io io; public UIntPtr process, job, peakProcess, peakJob; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint cb; public IntPtr reserved, desktop, title; public uint x,y,width,height,xchars,ychars,fill,flags;
    public ushort show, reservedLength; public IntPtr reservedBytes, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr env, string cwd, ref StartupEx startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool ok) { if(!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  public static int Run(string executable, string command, string cwd) {
    IntPtr job=IntPtr.Zero, limits=IntPtr.Zero, list=IntPtr.Zero, jobs=IntPtr.Zero, handles=IntPtr.Zero;
    ProcessInfo child=new ProcessInfo(); bool initialized=false;
    try {
      job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
      Check(SetHandleInformation(job,1,0));
      var settings=new Limits(); settings.basic.flags=0x2000;
      int length=Marshal.SizeOf(typeof(Limits)); limits=Marshal.AllocHGlobal(length);
      Marshal.StructureToPtr(settings,limits,false); Check(SetInformationJobObject(job,9,limits,(uint)length));
      IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size); Check(size!=IntPtr.Zero);
      list=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(list,2,0,ref size)); initialized=true;
      jobs=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs,job);
      Check(UpdateProcThreadAttribute(list,0,(IntPtr)0x0002000D,jobs,(IntPtr)IntPtr.Size,IntPtr.Zero,IntPtr.Zero));
      IntPtr input=GetStdHandle(-10), output=GetStdHandle(-11), error=GetStdHandle(-12);
      var inherited=new List<IntPtr>();
      foreach(IntPtr h in new IntPtr[]{input,output,error}) {
        Check(h!=IntPtr.Zero && h!=(IntPtr)(-1)); Check(SetHandleInformation(h,1,1));
        if(!inherited.Contains(h)) inherited.Add(h);
      }
      handles=Marshal.AllocHGlobal(IntPtr.Size*inherited.Count);
      for(int i=0;i<inherited.Count;i++) Marshal.WriteIntPtr(handles,i*IntPtr.Size,inherited[i]);
      Check(UpdateProcThreadAttribute(list,0,(IntPtr)0x00020002,handles,(IntPtr)(IntPtr.Size*inherited.Count),IntPtr.Zero,IntPtr.Zero));
      var start=new StartupEx(); start.startup.cb=(uint)Marshal.SizeOf(typeof(StartupEx)); start.attributes=list;
      // Preserve the launcher's hidden console for ordinary grandchildren.
      start.startup.flags=0x101; start.startup.show=0; start.startup.input=input; start.startup.output=output; start.startup.error=error;
      Check(CreateProcessW(executable,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x00080000,IntPtr.Zero,cwd,ref start,out child));
      Launched=true;
      Check(WaitForSingleObject(child.process,0xffffffff)==0);
      uint code; Check(GetExitCodeProcess(child.process,out code)); return unchecked((int)code);
    } finally {
      if(child.thread!=IntPtr.Zero) CloseHandle(child.thread);
      if(child.process!=IntPtr.Zero) CloseHandle(child.process);
      if(job!=IntPtr.Zero) CloseHandle(job);
      if(initialized) DeleteProcThreadAttributeList(list);
      foreach(IntPtr p in new IntPtr[]{limits,list,jobs,handles}) if(p!=IntPtr.Zero) Marshal.FreeHGlobal(p);
    }
  }
}
'@
  $result = [SeverallyJob]::Run([string]$spec.executable, [string]$spec.commandLine, [string]$spec.cwd)
  exit $result
} catch {
  $phase = 'launch failed'
  if (('SeverallyJob' -as [type]) -and [SeverallyJob]::Launched) { $phase = 'supervision failed after launch' }
  [Console]::Error.WriteLine('severally Windows job ' + $phase + ': ' + $_.Exception.Message)
  exit 1
}
`;

/** Windows CRT argv escaping; cmd shims already carry the existing verbatim quoting. @param {string} argument */
function quote(argument) {
  return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

/**
 * @param {string} executable Resolved executable, after the existing shebang/cmd handling.
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} options
 */
export function windowsJobInvocation(executable, args, options) {
  const commandLine = [quote(executable), ...args.map((arg) => (options.windowsVerbatimArguments ? arg : quote(arg)))].join(' ');
  const specification = Buffer.from(JSON.stringify({ executable, commandLine, cwd: options.cwd ?? process.cwd() })).toString(
    'base64',
  );
  return {
    command: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
    options: {
      ...options,
      windowsVerbatimArguments: false,
      env: { ...(options.env ?? process.env), SEVERALLY_PROCESS_SPEC: specification },
    },
  };
}
