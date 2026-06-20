package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

type ZLMConfig struct {
	APIBase string `yaml:"api_base"`
	Secret  string `yaml:"secret"`
	App     string `yaml:"app"`
	Vhost   string `yaml:"vhost"`
}

type Config struct {
	Listen         string    `yaml:"listen"`
	TLSCert        string    `yaml:"tls_cert"`
	TLSKey         string    `yaml:"tls_key"`
	StaticDir      string    `yaml:"static_dir"`
	AllowedOrigins []string  `yaml:"allowed_origins"`
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
	if c.ZLM.App == "" {
		c.ZLM.App = "meeting"
	}
	if c.ZLM.Vhost == "" {
		c.ZLM.Vhost = "__defaultVhost__"
	}
	return c, nil
}
