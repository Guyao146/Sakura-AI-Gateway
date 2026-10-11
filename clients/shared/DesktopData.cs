namespace SakuraAIGateway;

internal static class DesktopData
{
    internal static string Prepare(string? localAppData = null)
    {
        string root = localAppData ?? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string target = Path.Combine(root, "Sakura-AI-Gateway");
        if (Directory.Exists(target)) return target;
        // 旧名称仅用于迁移；复制成功后再切换，不覆盖新版配置，也不删除旧数据。
        string legacy = Path.Combine(root, "LocalModelGateway");
        if (!Directory.Exists(legacy))
        {
            Directory.CreateDirectory(target);
            return target;
        }
        string staging = Path.Combine(root, $".sakura-ai-gateway-migrate-{Guid.NewGuid():N}");
        try
        {
            CopyDirectory(legacy, staging);
            Directory.Move(staging, target);
        }
        finally
        {
            if (Directory.Exists(staging)) Directory.Delete(staging, true);
        }
        return target;
    }

    private static void CopyDirectory(string source, string target)
    {
        Directory.CreateDirectory(target);
        foreach (string file in Directory.EnumerateFiles(source))
            File.Copy(file, Path.Combine(target, Path.GetFileName(file)));
        foreach (string directory in Directory.EnumerateDirectories(source))
            CopyDirectory(directory, Path.Combine(target, Path.GetFileName(directory)));
    }
}