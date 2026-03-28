'use client';

import React from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
  Line,
  ComposedChart,
  Cell
} from 'recharts';

// 커스텀 라벨 컴포넌트
const CustomLabel = (props: any) => {
  const { x, y, value, fill } = props;
  return (
    <text 
      x={x} 
      y={y - 10} 
      fill={fill} 
      textAnchor="middle" 
      fontSize="12" 
      fontWeight="bold"
    >
      {value}ms
    </text>
  );
};

// 벤치마크: PDF 첫페이지 렌더링 시간 & TBT (CPU_THROTTLE=4, RUNS_PER_URL=10)
// - Basic (개선 전): firstPageRenderTime avg 3539.5ms, TBT avg 1551ms
// - Simple (No Track): firstPageRenderTime avg 3330.9ms, TBT avg 1141ms
// - Simple 75vh + rAF (K=8): firstPageRenderTime avg 3138.2ms, TBT avg 1056ms
const performanceData = [
  {
    version: 'Basic (개선 전)',
    pdfRenderTime: 3539.5,
    totalBlockingTime: 1551,
    color: '#ef4444' // red-500
  },
  {
    version: 'Simple (No Track)',
    pdfRenderTime: 3330.9,
    totalBlockingTime: 1141,
    color: '#f59e0b' // amber-500
  },
  {
    version: 'Simple 75vh + rAF',
    pdfRenderTime: 3138.2,
    totalBlockingTime: 1056,
    color: '#10b981' // emerald-500
  }
];

const PerformanceChartPage = () => {
  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* 헤더 */}
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">
            PDF 렌더링 성능 측정 결과
          </h1>
          <p className="text-xl text-gray-600">
            다양한 렌더링 방식의 성능 비교 분석
          </p>
        </div>

        {/* 개요 카드 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
          {performanceData.map((item, index) => (
            <div key={index} className="bg-white rounded-lg shadow-md p-6">
              <div className="flex items-center mb-4">
                <div 
                  className="w-4 h-4 rounded-full mr-3"
                  style={{ backgroundColor: item.color }}
                ></div>
                <h3 className="text-lg font-semibold text-gray-900">
                  {item.version}
                </h3>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-gray-600">PDF 렌더링 시간:</span>
                  <span className="font-semibold">{item.pdfRenderTime}ms</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Total Blocking Time:</span>
                  <span className="font-semibold">{item.totalBlockingTime}ms</span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* PDF 렌더링 시간 차트 */}
        <div className="bg-white rounded-lg shadow-md p-6 mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-6 text-center">
            PDF 첫 페이지 렌더링 시간 비교
          </h2>
          <div className="h-96">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={performanceData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis 
                  dataKey="version" 
                  tick={{ fontSize: 12 }}
                  angle={-45}
                  textAnchor="end"
                  height={100}
                />
                <YAxis 
                  label={{ value: '시간 (ms)', angle: -90, position: 'insideLeft' }}
                />
                <Tooltip 
                  formatter={(value: number) => [`${value}ms`, '렌더링 시간']}
                  labelFormatter={(label) => `버전: ${label}`}
                />
                <Bar dataKey="pdfRenderTime" radius={[4, 4, 0, 0]}>
                  {performanceData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Total Blocking Time 차트 */}
        <div className="bg-white rounded-lg shadow-md p-6 mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-6 text-center">
            Total Blocking Time 비교
          </h2>
          <div className="h-96">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={performanceData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis 
                  dataKey="version" 
                  tick={{ fontSize: 12 }}
                  angle={-45}
                  textAnchor="end"
                  height={100}
                />
                <YAxis 
                  label={{ value: '시간 (ms)', angle: -90, position: 'insideLeft' }}
                />
                <Tooltip 
                  formatter={(value: number) => [`${value}ms`, 'Total Blocking Time']}
                  labelFormatter={(label) => `버전: ${label}`}
                />
                <Bar dataKey="totalBlockingTime" radius={[4, 4, 0, 0]}>
                  {performanceData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* 통합 비교 차트 */}
        <div className="bg-white rounded-lg shadow-md p-6 mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-6 text-center">
            성능 지표 통합 비교
          </h2>
          <div className="h-96">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={performanceData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis 
                  dataKey="version" 
                  tick={{ fontSize: 14, fontWeight: 'bold' }}
                  height={80}
                />
                <YAxis 
                  label={{ value: '시간 (ms)', angle: -90, position: 'insideLeft', style: { fontSize: 14, fontWeight: 'bold' } }}
                  tick={{ fontSize: 12 }}
                />
                <Tooltip 
                  formatter={(value: number, name: string) => [
                    `${value}ms`, 
                    name === 'pdfRenderTime' ? 'PDF 렌더링 시간' : 'Total Blocking Time'
                  ]}
                  labelFormatter={(label) => `버전: ${label}`}
                  contentStyle={{ fontSize: 14 }}
                />
                <Legend />
                <Line 
                  type="linear" 
                  dataKey="pdfRenderTime" 
                  name="PDF 렌더링 시간"
                  stroke="#3b82f6"
                  strokeWidth={4}
                  dot={{ fill: '#3b82f6', strokeWidth: 2, r: 8 }}
                  label={<CustomLabel fill="#3b82f6" />}
                />
                <Line 
                  type="linear" 
                  dataKey="totalBlockingTime" 
                  name="Total Blocking Time"
                  stroke="#ef4444"
                  strokeWidth={4}
                  dot={{ fill: '#ef4444', strokeWidth: 2, r: 8 }}
                  label={<CustomLabel fill="#ef4444" />}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* 성능 개선 요약 */}
        <div className="bg-gradient-to-r from-green-50 to-blue-50 rounded-lg shadow-md p-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-6 text-center">
            성능 개선 요약
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-4">
                🏆 최고 성능: Simple 75vh + rAF
              </h3>
              <ul className="space-y-2 text-gray-700">
                <li>• PDF 첫페이지 렌더링 시간: <span className="font-semibold text-green-600">3138.2ms</span> (가장 빠름)</li>
                <li>• Total Blocking Time: <span className="font-semibold text-green-600">1056ms</span> (가장 낮음)</li>
                <li>• Basic 대비 렌더링 시간 <span className="font-semibold text-green-600">약 11.3% 개선</span></li>
                <li>• Basic 대비 TBT <span className="font-semibold text-green-600">약 32.0% 개선</span></li>
              </ul>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-4">
                📊 성능 분석
              </h3>
              <ul className="space-y-2 text-gray-700">
                <li>• <span className="font-semibold">Simple 75vh + rAF</span>가 모든 지표에서 최고 성능</li>
                <li>• <span className="font-semibold">Simple (No Track)</span>은 Basic 대비 렌더링 시간과 TBT 모두 개선</li>
                <li>• <span className="font-semibold">Total Blocking Time</span>이 사용자 경험에 더 중요한 지표</li>
                <li>• <span className="font-semibold">뷰포트 기반 프리워밍 + 동시성 제어 + rAF 배칭</span> 조합이 가장 효율적인 렌더링 전략</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PerformanceChartPage;
