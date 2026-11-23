; StudyGraph 桌面版安装包（Inno Setup 6）
;
; 用法：
;   ISCC.exe scripts\desktop-installer.iss /DSourceDir="dist-desktop\20261120141858\StudyGraph" /DAppVersion="0.1.0"
;
; 两个必须遵守的约束（都是实测踩出来的，改之前先看 docs/桌面-内置数据库构建.md）：
;   · 安装路径必须是纯 ASCII：Electron 二进制在含中文的目录下启动即崩，PostgreSQL 二进制同理
;   · 数据在 {localappdata}\StudyGraph，卸载时问用户要不要一并删掉

#ifndef SourceDir
  #error 必须用 /DSourceDir= 指定打包产物目录
#endif
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

#define AppName "StudyGraph"
#define AppExe "StudyGraph.exe"

[Setup]
; AppId 固定不变：改了会导致升级安装变成并存安装
AppId={{8E3D7A21-5C46-4F0B-9B7E-2A6C1F5D4B93}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\dist-desktop\installer
OutputBaseFilename=StudyGraph-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
; 按用户安装：不要求管理员权限，学生机器上通常也没有管理员
PrivilegesRequired=lowest

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent

[Code]
const
  DataDirName = 'StudyGraph';
  NL = #13#10;

function IsAsciiPath(const S: String): Boolean;
var
  I: Integer;
begin
  Result := True;
  for I := 1 to Length(S) do
    if Ord(S[I]) > 127 then
    begin
      Result := False;
      Exit;
    end;
end;

{ 安装目录必须纯 ASCII —— 否则 Electron 起不来，学生只会看到"双击没反应" }
function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = wpSelectDir then
  begin
    if not IsAsciiPath(WizardDirValue) then
    begin
      MsgBox('The installation path must contain only English letters, digits and symbols.' + #13#10 +
             'PostgreSQL and Electron cannot run from a path with Chinese characters.' + #13#10#13#10 +
             'Please choose a path such as C:\Program Files\StudyGraph.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

{ 数据目录定位 }
{ 应用启动时会把真实数据目录写进 %LOCALAPPDATA%\StudyGraph-data-dir.txt。
  为什么要读它：数据目录有三档回退（LOCALAPPDATA → ProgramData → 系统盘根），
  用户名是中文时会落到后两档。只猜第一档的话，"保留数据"是对着空路径做完的，
  用户以为保住了，重装却把数据重新初始化了。 }
{ 只读 localappdata：app 常量在 InitializeSetup 阶段还不存在 }
function ReadMarkedDataDir(): String;
var
  S: AnsiString;
begin
  Result := '';
  if FileExists(ExpandConstant('{localappdata}\\StudyGraph-data-dir.txt')) then
  begin
    if LoadStringFromFile(ExpandConstant('{localappdata}\\StudyGraph-data-dir.txt'), S) then
      Result := Trim(String(S));
  end;
  if (Result <> '') and not DirExists(Result) then Result := '';
end;

function DataDirPath(): String;
begin
  Result := ReadMarkedDataDir();
  if Result = '' then
    Result := ExpandConstant('{localappdata}' + DataDirName);
end;

{ 数据大小：让人在删除前知道要失去多少（只有一堆数字，不会有别的信息泄露） }
function DirSizeMB(const Dir: String; Level: Integer): Integer;
var
  FindRec: TFindRec;
  Sub: String;
begin
  Result := 0;
  if Level > 6 then Exit;
  if not FindFirst(Dir + '*', FindRec) then Exit;
  try
    repeat
      if (FindRec.Name <> '.') and (FindRec.Name <> '..') then
      begin
        if FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY <> 0 then
        begin
          Sub := Dir + '' + FindRec.Name;
          Result := Result + DirSizeMB(Sub, Level + 1);
        end
        else
          Result := Result + (FindRec.SizeHigh * 4096) + (FindRec.SizeLow div 262144);
      end;
    until not FindNext(FindRec);
  finally
    FindClose(FindRec);
  end;
end;

{ 卸载时询问是否删除数据（数据库、课件、本机 token、BYOK 主密钥都在这里） }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
  SizeMB: Integer;
  AskResult: Integer;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := DataDirPath();
    if DirExists(DataDir) then
    begin
      SizeMB := DirSizeMB(DataDir, 0);
      AskResult := MsgBox(
        'Also delete your StudyGraph data?' + NL + NL +
        'Location: ' + DataDir + NL +
        'Size: about ' + IntToStr(SizeMB) + ' MB' + NL + NL +
        'It contains all canvases, uploaded course files, your question bank, review history, ' +
        'and the saved API keys (encrypted).' + NL + NL +
        'YES = delete everything (cannot be undone)' + NL +
        'NO  = keep the data. If you install StudyGraph again on this machine, ' +
        'it will pick the data up automatically.',
        mbConfirmation, MB_YESNO);
      if AskResult = IDYES then
      begin
        DelTree(DataDir, True, True, True);
        DeleteFile(ExpandConstant('{localappdata}\\StudyGraph-data-dir.txt'));
        { 只删我们自己生成的那份标记，不动安装目录里的其它文件 }
        DeleteFile(ExpandConstant('{app}\\data-dir.txt'));
      end
      else
      begin
        { 保留数据：把位置写进卸载信息旁边，重装时安装程序据此提示"检测到旧数据" }
        SaveStringToFile(
          ExpandConstant('{app}\\kept-data.txt'),
          DataDir,
          False);
      end;
    end;
  end;
end;

{
  重装检测：上一次卸载选择了"保留数据"，或者干脆没卸载就重装。
  这里只做提示，不自动删、不自动覆盖 —— 数据是用户的，不能替他决定。
}
function InitializeSetup(): Boolean;
var
  DataDir: String;
  S: AnsiString;
begin
  Result := True;
  DataDir := ReadMarkedDataDir();
  if (DataDir = '') and DirExists(ExpandConstant('{localappdata}' + DataDirName)) then
    DataDir := ExpandConstant('{localappdata}' + DataDirName);
  if DataDir = '' then Exit;

  if not FileExists(DataDir + 'PG_VERSION') then Exit;

  if MsgBox(
       'Found existing StudyGraph data:' + NL + NL +
       DataDir + NL + NL +
       'Installing will KEEP it and pick it up automatically' + NL +
       '(your canvases, course files, question bank and settings stay).' + NL + NL +
       'Continue?',
       mbInformation, MB_OKCANCEL) = IDCANCEL then
    Result := False;
end;
