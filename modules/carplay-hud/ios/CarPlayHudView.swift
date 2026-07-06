import UIKit

final class CarPlayHudView: UIView {

  // MARK: - Subviews

  private let leftPanel       = UIView()
  private let separator       = UIView()
  private let rightPanel      = UIView()
  private let speedTitleLabel = UILabel()
  private let speedLabel      = UILabel()
  private let unitLabel       = UILabel()
  private let signBorderView  = UIView()
  private let limitTitleLabel = UILabel()
  private let limitLabel      = UILabel()

  // MARK: - Init

  override init(frame: CGRect) {
    super.init(frame: frame)
    setupUI()
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    setupUI()
  }

  // MARK: - Setup

  private func setupUI() {
    let darkBg = UIColor(hex: "#0b0d12") ?? UIColor(red: 0.043, green: 0.051, blue: 0.071, alpha: 1)
    backgroundColor = darkBg

    // Left panel — dark background, speed readout
    leftPanel.translatesAutoresizingMaskIntoConstraints = false
    leftPanel.backgroundColor = darkBg
    addSubview(leftPanel)

    // "CURRENT SPEED" label
    speedTitleLabel.translatesAutoresizingMaskIntoConstraints = false
    speedTitleLabel.attributedText = kerned(
      "CURRENT SPEED", size: 14,
      color: UIColor(hex: "#aaaaaa") ?? .lightGray, kern: 3
    )
    speedTitleLabel.textAlignment = .center
    leftPanel.addSubview(speedTitleLabel)

    // Speed value — large, colored
    speedLabel.translatesAutoresizingMaskIntoConstraints = false
    speedLabel.text = "--"
    speedLabel.textColor = .white
    speedLabel.font = .systemFont(ofSize: 120, weight: .heavy)
    speedLabel.textAlignment = .center
    speedLabel.adjustsFontSizeToFitWidth = true
    speedLabel.minimumScaleFactor = 0.4
    leftPanel.addSubview(speedLabel)

    // Unit label — "MPH" or "KM/H" below the speed number
    unitLabel.translatesAutoresizingMaskIntoConstraints = false
    unitLabel.text = "MPH"
    unitLabel.textColor = UIColor(hex: "#aaaaaa") ?? .lightGray
    unitLabel.font = .systemFont(ofSize: 20, weight: .semibold)
    unitLabel.textAlignment = .center
    leftPanel.addSubview(unitLabel)

    // Separator — 2pt vertical line, matches borderLeftWidth: 2, borderLeftColor: '#ccc'
    separator.translatesAutoresizingMaskIntoConstraints = false
    separator.backgroundColor = UIColor(hex: "#cccccc") ?? .lightGray
    addSubview(separator)

    // Right panel — white
    rightPanel.translatesAutoresizingMaskIntoConstraints = false
    rightPanel.backgroundColor = .white
    addSubview(rightPanel)

    // Speed limit sign border — matches borderWidth: 4, borderColor: '#000', borderRadius: 8
    signBorderView.translatesAutoresizingMaskIntoConstraints = false
    signBorderView.backgroundColor = .white
    signBorderView.layer.borderWidth = 4
    signBorderView.layer.borderColor = UIColor.black.cgColor
    signBorderView.layer.cornerRadius = 8
    rightPanel.addSubview(signBorderView)

    // "SPEED LIMIT" label
    limitTitleLabel.translatesAutoresizingMaskIntoConstraints = false
    limitTitleLabel.attributedText = kerned(
      "SPEED LIMIT", size: 14,
      color: UIColor(hex: "#666666") ?? .gray, kern: 3
    )
    limitTitleLabel.textAlignment = .center
    signBorderView.addSubview(limitTitleLabel)

    // Limit value
    limitLabel.translatesAutoresizingMaskIntoConstraints = false
    limitLabel.text = "--"
    limitLabel.textColor = .black
    limitLabel.font = .systemFont(ofSize: 120, weight: .heavy)
    limitLabel.textAlignment = .center
    limitLabel.adjustsFontSizeToFitWidth = true
    limitLabel.minimumScaleFactor = 0.4
    signBorderView.addSubview(limitLabel)

    setupConstraints()
  }

  private func setupConstraints() {
    NSLayoutConstraint.activate([
      // Left panel: leading half
      leftPanel.leadingAnchor.constraint(equalTo: leadingAnchor),
      leftPanel.topAnchor.constraint(equalTo: topAnchor),
      leftPanel.bottomAnchor.constraint(equalTo: bottomAnchor),
      leftPanel.widthAnchor.constraint(equalTo: widthAnchor, multiplier: 0.5),

      // Separator: 2pt between panels
      separator.leadingAnchor.constraint(equalTo: leftPanel.trailingAnchor),
      separator.topAnchor.constraint(equalTo: topAnchor),
      separator.bottomAnchor.constraint(equalTo: bottomAnchor),
      separator.widthAnchor.constraint(equalToConstant: 2),

      // Right panel: trailing half
      rightPanel.leadingAnchor.constraint(equalTo: separator.trailingAnchor),
      rightPanel.topAnchor.constraint(equalTo: topAnchor),
      rightPanel.bottomAnchor.constraint(equalTo: bottomAnchor),
      rightPanel.trailingAnchor.constraint(equalTo: trailingAnchor),

      // Speed group: title above number, number centered, unit below
      speedLabel.centerXAnchor.constraint(equalTo: leftPanel.centerXAnchor),
      speedLabel.centerYAnchor.constraint(equalTo: leftPanel.centerYAnchor),
      speedLabel.leadingAnchor.constraint(greaterThanOrEqualTo: leftPanel.leadingAnchor, constant: 16),
      speedLabel.trailingAnchor.constraint(lessThanOrEqualTo: leftPanel.trailingAnchor, constant: -16),

      speedTitleLabel.centerXAnchor.constraint(equalTo: leftPanel.centerXAnchor),
      speedTitleLabel.bottomAnchor.constraint(equalTo: speedLabel.topAnchor, constant: -6),

      unitLabel.centerXAnchor.constraint(equalTo: leftPanel.centerXAnchor),
      unitLabel.topAnchor.constraint(equalTo: speedLabel.bottomAnchor, constant: 4),

      // Sign border fills the right panel with 16pt inset (matches padding: 16 in RN)
      signBorderView.leadingAnchor.constraint(equalTo: rightPanel.leadingAnchor, constant: 16),
      signBorderView.trailingAnchor.constraint(equalTo: rightPanel.trailingAnchor, constant: -16),
      signBorderView.topAnchor.constraint(equalTo: rightPanel.topAnchor, constant: 16),
      signBorderView.bottomAnchor.constraint(equalTo: rightPanel.bottomAnchor, constant: -16),

      // Limit title pinned to top of sign
      limitTitleLabel.centerXAnchor.constraint(equalTo: signBorderView.centerXAnchor),
      limitTitleLabel.topAnchor.constraint(equalTo: signBorderView.topAnchor, constant: 16),

      // Limit value centered in sign
      limitLabel.centerXAnchor.constraint(equalTo: signBorderView.centerXAnchor),
      limitLabel.centerYAnchor.constraint(equalTo: signBorderView.centerYAnchor),
      limitLabel.leadingAnchor.constraint(greaterThanOrEqualTo: signBorderView.leadingAnchor, constant: 20),
      limitLabel.trailingAnchor.constraint(lessThanOrEqualTo: signBorderView.trailingAnchor, constant: -20),
    ])
  }

  // MARK: - Update

  func update(data: HudData) {
    speedLabel.text = data.speed >= 0 ? "\(data.speed)" : "--"
    speedLabel.textColor = UIColor(hex: data.speedColor) ?? .white
    limitLabel.text = data.limit.map { "\($0)" } ?? "--"
    unitLabel.text = data.unit == "kmh" ? "KM/H" : "MPH"
  }

  // MARK: - Helpers

  private func kerned(_ text: String, size: CGFloat, color: UIColor, kern: CGFloat) -> NSAttributedString {
    NSAttributedString(string: text, attributes: [
      .foregroundColor: color,
      .font: UIFont.systemFont(ofSize: size, weight: .regular),
      .kern: kern,
    ])
  }
}

// MARK: - UIColor hex extension

extension UIColor {
  convenience init?(hex: String) {
    let cleaned = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
    var raw: UInt64 = 0
    guard Scanner(string: cleaned).scanHexInt64(&raw) else { return nil }
    let a: UInt64, r: UInt64, g: UInt64, b: UInt64
    switch cleaned.count {
    case 3:
      (a, r, g, b) = (255, (raw >> 8) * 17, (raw >> 4 & 0xF) * 17, (raw & 0xF) * 17)
    case 6:
      (a, r, g, b) = (255, raw >> 16, raw >> 8 & 0xFF, raw & 0xFF)
    case 8:
      (a, r, g, b) = (raw >> 24, raw >> 16 & 0xFF, raw >> 8 & 0xFF, raw & 0xFF)
    default:
      return nil
    }
    self.init(
      red:   CGFloat(r) / 255,
      green: CGFloat(g) / 255,
      blue:  CGFloat(b) / 255,
      alpha: CGFloat(a) / 255
    )
  }
}
