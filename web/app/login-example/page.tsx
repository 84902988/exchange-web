'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/authContext';

export default function LoginExample() {
  const { isLoggedIn, user, loading, login, logout, error } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showForm, setShowForm] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await login(email, password);
      setShowForm(false);
      setEmail('');
      setPassword('');
    } catch (err) {
      // 错误已在authContext中处理，会显示在error状态中
    }
  };

  const handleLogout = async () => {
    await logout();
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0d] flex items-center justify-center">
        <div className="text-white text-lg">加载中...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0d] p-6">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold text-white mb-6">登录状态示例</h1>
        
        {/* 登录状态信息 */}
        <div className="bg-white/5 border border-white/10 rounded-lg p-6 mb-6">
          <h2 className="text-xl font-semibold text-white mb-4">当前登录状态</h2>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-4 bg-white/10 rounded-md">
              <span className="text-white/70 text-sm block mb-1">登录状态:</span>
              <span className={`text-lg font-medium ${isLoggedIn ? 'text-green-400' : 'text-red-400'}`}>
                {isLoggedIn ? '已登录' : '未登录'}
              </span>
            </div>
            
            {isLoggedIn && user && (
              <div className="p-4 bg-white/10 rounded-md">
                <span className="text-white/70 text-sm block mb-1">用户名:</span>
                <span className="text-lg font-medium text-white">{user.email || user.phone || '未设置'}</span>
              </div>
            )}
          </div>
          
          {error && (
            <div className="mt-4 p-3 bg-red-500/20 border border-red-500/30 rounded-md">
              <span className="text-red-400 text-sm">{error}</span>
            </div>
          )}
        </div>
        
        {/* 登录/登出操作 */}
        <div className="bg-white/5 border border-white/10 rounded-lg p-6">
          <h2 className="text-xl font-semibold text-white mb-4">操作</h2>
          
          {!isLoggedIn ? (
            <div className="space-y-4">
              {!showForm ? (
                <button
                  onClick={() => setShowForm(true)}
                  className="px-6 py-3 bg-amber-500 hover:bg-amber-600 text-white font-medium rounded-md transition-colors"
                >
                  显示登录表单
                </button>
              ) : (
                <form onSubmit={handleLogin} className="space-y-4">
                  <div>
                    <label htmlFor="email" className="block text-white/70 text-sm mb-2">邮箱/手机号</label>
                    <input
                      type="text"
                      id="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full px-4 py-2 bg-white/10 border border-white/15 rounded-md text-white placeholder-white/50 focus:outline-none focus:border-amber-500"
                      placeholder="请输入邮箱或手机号"
                      required
                    />
                  </div>
                  
                  <div>
                    <label htmlFor="password" className="block text-white/70 text-sm mb-2">密码</label>
                    <input
                      type="password"
                      id="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full px-4 py-2 bg-white/10 border border-white/15 rounded-md text-white placeholder-white/50 focus:outline-none focus:border-amber-500"
                      placeholder="请输入密码"
                      required
                    />
                  </div>
                  
                  <div className="flex gap-4">
                    <button
                      type="submit"
                      className="flex-1 px-6 py-3 bg-amber-500 hover:bg-amber-600 text-white font-medium rounded-md transition-colors"
                    >
                      登录
                    </button>
                    
                    <button
                      type="button"
                      onClick={() => {
                        setShowForm(false);
                        setEmail('');
                        setPassword('');
                      }}
                      className="flex-1 px-6 py-3 bg-white/10 hover:bg-white/20 text-white font-medium rounded-md transition-colors"
                    >
                      取消
                    </button>
                  </div>
                </form>
              )}
            </div>
          ) : (
            <button
              onClick={handleLogout}
              className="px-6 py-3 bg-red-500 hover:bg-red-600 text-white font-medium rounded-md transition-colors"
            >
              登出
            </button>
          )}
        </div>
        
        {/* 说明 */}
        <div className="mt-6 bg-white/5 border border-white/10 rounded-lg p-6">
          <h2 className="text-xl font-semibold text-white mb-4">说明</h2>
          <ul className="space-y-2 text-white/80 text-sm">
            <li>• 此页面展示了如何使用 useAuth 钩子管理登录状态</li>
            <li>• 登录状态会自动同步到整个应用</li>
            <li>• Token 会每5分钟检查一次是否过期，过期后会自动登出</li>
            <li>• 登录状态变化时，页面会自动更新</li>
            <li>• Header 组件也会根据登录状态显示不同的内容</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
