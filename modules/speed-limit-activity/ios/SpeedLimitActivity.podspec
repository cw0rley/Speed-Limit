Pod::Spec.new do |s|
  s.name           = 'SpeedLimitActivity'
  s.version        = '1.0.0'
  s.summary        = 'Starts/updates the Speed Limit Live Activity from JS'
  s.description    = s.summary
  s.author         = ''
  s.homepage       = 'https://github.com/cw0rley/speed-limit'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.{h,m,swift}'
end
