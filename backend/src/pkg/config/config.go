package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// ZLMConfig only carries the bits needed to talk to the ZLMediaKit REST API.
// The ZLM "app" (stream group) is decided per-call by the front end (mapped
// from the user-supplied "room"), so it is intentionally not part of the
// static configuration.
type ZLMConfig struct {
	APIBase string `yaml:"api_base"`
	Secret  string `yaml:"secret"`
}

type Config struct {
	Listen         string    `yaml:"listen"`
	TLSCert        string    `yaml:"tls_cert"`
	TLSKey         string    `yaml:"tls_key"`
	LogLevel       string    `yaml:"log_level"`
	StaticDir      string    `yaml:"static_dir"`
	AllowedOrigins []string  `yaml:"allowed_origins"`
	// Token is required on business requests when non-empty (entry-check + join).
	Token          string    `yaml:"token"`
	// Admin HTTPS listener and static admin UI (separate from business port).
	// Uses the same tls_cert / tls_key and token as the business server.
	AdminListen    string    `yaml:"admin_listen"`
	AdminStaticDir string    `yaml:"admin_static_dir"`
	ZLM            ZLMConfig `yaml:"zlm"`
}

// Load reads configuration from a YAML file, applying defaults.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	c := &Config{}
	if err := yaml.Unmarshal(data, c); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	if c.Listen == "" {
		c.Listen = ":8080"
	}
	if c.ZLM.APIBase == "" {
		c.ZLM.APIBase = "http://127.0.0.1:80"
	}
	return c, nil
}
